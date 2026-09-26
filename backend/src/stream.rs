//! On-demand HLS proxy: one ffmpeg child per room, mux/transcoding a source
//! stream into HLS segments on the shared RAM disk (`{streams_dir}/{room}/`).
//!
//! Lifecycle (driven from `ws.rs`):
//!   • media set (non-YouTube) → [`StreamManager::start`] spawns ffmpeg.
//!   • seek                    → `start` again with a new `-ss` offset (the old
//!                               child is killed first).
//!   • media cleared / room reaped → [`StreamManager::stop`] kills + wipes.
//!
//! Zombie prevention is belt-and-suspenders:
//!   1. Every child is `kill_on_drop(true)`, so dropping a handle SIGKILLs and
//!      reaps it even on a panic/early-return path.
//!   2. Each child is owned by a supervisor task that `child.wait().await`s it
//!      (reaping the PID) and `child.kill().await`s it on an explicit signal.
//!   3. A monotonic generation guards every async callback so a superseded
//!      ffmpeg can never report ready/exit against a newer stream.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{sleep, Instant};

use crate::protocol::Media;
use crate::state::AppState;

/// Playlist filename written into each room dir. Segment URIs in it are relative
/// (`seg_00001.ts`), so they resolve under the same `/api/streams/{room}/` path.
const PLAYLIST_NAME: &str = "index.m3u8";
const SEGMENT_PATTERN: &str = "seg_%05d.ts";
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// ffmpeg stderr lines kept for the log. At `-loglevel warning` a healthy run
/// prints nothing, and a failing one says why in its last few lines.
const STDERR_TAIL_LINES: usize = 20;
const STDERR_LINE_MAX: usize = 300;

/// The inputs ffmpeg should mux. Either a single combined source (direct file,
/// HLS, or an already-muxed resolver result) or a separate video + audio pair.
pub struct StreamSource {
    pub video_url: String,
    pub video_headers: Vec<(String, String)>,
    pub audio_url: Option<String>,
    pub audio_headers: Vec<(String, String)>,
}

impl StreamSource {
    /// A single combined input (no separate audio track).
    pub fn single(url: String, headers: Vec<(String, String)>) -> Self {
        StreamSource {
            video_url: url,
            video_headers: headers,
            audio_url: None,
            audio_headers: Vec::new(),
        }
    }
}

struct Session {
    generation: u64,
    /// Fires the explicit `child.kill().await` in the supervisor. `Option` so we
    /// can take it once.
    kill: Option<oneshot::Sender<()>>,
}

pub struct StreamManager {
    dir: PathBuf,
    hls_segment_sec: u32,
    max_bytes: u64,
    audio_bitrate: String,
    ready_timeout: Duration,
    next_gen: AtomicU64,
    sessions: Mutex<HashMap<String, Session>>,
}

impl StreamManager {
    pub fn new(
        dir: PathBuf,
        hls_segment_sec: u32,
        audio_bitrate: String,
        ready_timeout_sec: u64,
        max_bytes: u64,
    ) -> Self {
        StreamManager {
            dir,
            hls_segment_sec: hls_segment_sec.max(1),
            max_bytes,
            audio_bitrate,
            ready_timeout: Duration::from_secs(ready_timeout_sec.max(1)),
            next_gen: AtomicU64::new(0),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// A fresh monotonic generation, recorded on the room's `StreamInfo` before
    /// `start` is called so callbacks can detect supersession.
    pub fn next_generation(&self) -> u64 {
        self.next_gen.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Spawn ffmpeg for `room_id` at content-second `offset`, killing any prior
    /// child for the room. Idempotent against superseding generations: if a
    /// newer (or equal) stream already owns the room, this is a no-op.
    /// `live` switches the playlist to a sliding window (see `build_command`).
    pub async fn start(
        &self,
        state: Arc<AppState>,
        room_id: String,
        generation: u64,
        offset: f64,
        source: StreamSource,
        live: bool,
    ) {
        // The room may have moved on (another change/seek) while we were
        // resolving the source URLs.
        if current_generation_is(&state, &room_id, generation).await != Some(true) {
            return;
        }

        let room_dir = self.dir.join(&room_id);
        let mut cmd = self.build_command(&room_dir, offset, &source, live);

        // LOCK ORDER: `sessions` then `rooms`, never the reverse. Every
        // streams.stop() call site drops the rooms guard before calling in, so
        // this direction is the one the codebase already relies on -- keep it.
        let mut sessions = self.sessions.lock().await;

        // Re-check the generation while HOLDING `sessions`. The check at the
        // top of this fn is not enough: between it and the insert below, a reap
        // could run stop(), find no session to kill, wipe the directory, and
        // drop the room -- after which this spawn would create a child with no
        // session record and no room, so nothing would ever kill it. It then
        // transcodes into the shared tmpfs until ENOSPC takes out every other
        // room's ffmpeg too.
        if current_generation_is(&state, &room_id, generation).await != Some(true) {
            return;
        }

        // Another spawn already owns this room with an equal/newer generation.
        if let Some(existing) = sessions.get(&room_id) {
            if existing.generation >= generation {
                return;
            }
        }
        // Kill the prior (older) child before touching its files.
        if let Some(mut old) = sessions.remove(&room_id) {
            if let Some(tx) = old.kill.take() {
                let _ = tx.send(());
            }
        }
        // Fresh, empty room dir on the RAM disk. tmpfs ops are fast, but an
        // event playlist can hold thousands of segments, so the unlink walk
        // goes to the blocking pool rather than stalling a runtime worker.
        let dir_for_reset = room_dir.clone();
        let reset = tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&dir_for_reset);
            std::fs::create_dir_all(&dir_for_reset)
        })
        .await;
        match reset {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                drop(sessions);
                tracing::error!("stream {room_id}: failed to create {room_dir:?}: {e}");
                mark_error(&state, &room_id, generation).await;
                return;
            }
            Err(e) => {
                drop(sessions);
                tracing::error!("stream {room_id}: room dir reset task failed: {e}");
                mark_error(&state, &room_id, generation).await;
                return;
            }
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                drop(sessions);
                tracing::error!("stream {room_id}: ffmpeg spawn failed: {e}");
                mark_error(&state, &room_id, generation).await;
                return;
            }
        };
        tracing::info!("stream {room_id}: ffmpeg gen={generation} offset={offset:.1}s live={live}");
        let stderr_tail = child.stderr.take().map(collect_stderr_tail);

        let (kill_tx, kill_rx) = oneshot::channel();
        sessions.insert(
            room_id.clone(),
            Session {
                generation,
                kill: Some(kill_tx),
            },
        );
        drop(sessions);

        // Supervisor owns the child (reaps + explicit kill). Readiness poller
        // flips the room to ready once the playlist lands.
        tokio::spawn(supervise(
            child,
            kill_rx,
            stderr_tail,
            room_dir.clone(),
            state.clone(),
            room_id.clone(),
            generation,
        ));
        let playlist = room_dir.join(PLAYLIST_NAME);
        tokio::spawn(poll_ready(playlist, state, room_id, generation, self.ready_timeout));
    }

    /// Kill every live ffmpeg child. Used on shutdown so children are not
    /// orphaned to init when the process goes away (see the call site in
    /// `main`). Directories are left alone — the next boot wipes the tmpfs.
    pub async fn stop_all(&self) {
        let mut sessions = self.sessions.lock().await;
        let count = sessions.len();
        for (_room, mut session) in sessions.drain() {
            if let Some(tx) = session.kill.take() {
                let _ = tx.send(());
            }
        }
        if count > 0 {
            tracing::info!("stopped {count} ffmpeg child(ren) on shutdown");
        }
    }

    /// Kill the room's ffmpeg (if any) and wipe its RAM-disk directory.
    pub async fn stop(&self, room_id: &str) {
        if let Some(mut s) = self.sessions.lock().await.remove(room_id) {
            if let Some(tx) = s.kill.take() {
                let _ = tx.send(());
            }
        }
        let room_dir = self.dir.join(room_id);
        let _ = tokio::fs::remove_dir_all(&room_dir).await;
    }

    /// Drop the session record if it's still `generation` (called by the
    /// supervisor when ffmpeg exits on its own, e.g. EOF on a finite file).
    async fn forget(&self, room_id: &str, generation: u64) {
        let mut sessions = self.sessions.lock().await;
        if sessions.get(room_id).map(|s| s.generation) == Some(generation) {
            sessions.remove(room_id);
        }
    }

    fn build_command(&self, room_dir: &Path, offset: f64, source: &StreamSource, live: bool) -> Command {
        let mut cmd = Command::new("ffmpeg");
        // Run inside the room dir so segment URIs in the playlist stay relative.
        cmd.current_dir(room_dir)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            // Piped and drained into a short tail for the log (see
            // collect_stderr_tail). It used to go to /dev/null, so no ffmpeg
            // failure — a 403 from the origin, a codec it cannot remux — ever
            // reached `docker logs`, which the README tells operators to read.
            .stderr(Stdio::piped())
            .arg("-nostdin")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("warning")
            // Pin the protocols ffmpeg may use. Inputs here are user-pasted or
            // resolver-derived, and an .m3u8 can name arbitrary sub-resources;
            // without this an attacker-authored playlist can reach `file:` and
            // read the container filesystem back into the room's stream.
            // `file` stays in the list because the HLS muxer writes segments
            // through it; `crypto`/`data` are needed for encrypted HLS.
            .arg("-protocol_whitelist")
            .arg("file,crypto,data,http,https,tcp,tls,httpproxy")
            .arg("-y");

        add_input(&mut cmd, offset, &source.video_url, &source.video_headers);
        let separate = source.audio_url.is_some();
        if let Some(audio) = &source.audio_url {
            add_input(&mut cmd, offset, audio, &source.audio_headers);
        }

        if separate {
            // Distinct inputs: video from 0, audio from 1.
            cmd.arg("-map").arg("0:v:0").arg("-map").arg("1:a:0");
        } else {
            // One input: its video + (optional) audio. `?` makes the audio map
            // non-fatal for video-only sources.
            cmd.arg("-map").arg("0:v:0?").arg("-map").arg("0:a:0?");
        }

        // Pass video through (cheap); transcode audio to AAC so the browser can
        // always decode it (this is what fixes MKV's AC-3/DTS audio).
        cmd.arg("-c:v")
            .arg("copy")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg(&self.audio_bitrate)
            .arg("-f")
            .arg("hls")
            .arg("-hls_time")
            .arg(self.hls_segment_sec.to_string())
            .arg("-hls_segment_type")
            .arg("mpegts")
            .arg("-hls_segment_filename")
            .arg(SEGMENT_PATTERN);
        if live {
            // Live sources have no end and no shared scrub position (the client
            // plays the live edge), so keep a sliding window and delete old
            // segments — an event playlist would grow the RAM disk until ENOSPC.
            cmd.arg("-hls_list_size")
                .arg("12")
                .arg("-hls_flags")
                .arg("independent_segments+delete_segments");
        } else {
            // Finite media: an event playlist keeps every segment, so the room's
            // whole timeline stays seekable off the RAM disk.
            cmd.arg("-hls_playlist_type")
                .arg("event")
                .arg("-hls_flags")
                .arg("independent_segments");
        }
        // Per-room byte budget. The old comment called the RAM disk
        // "size-capped", but the only cap was the whole shared volume
        // (STREAMS_TMPFS_SIZE, default 2g) -- with an event playlist keeping
        // every segment and no -fs/-t, one long high-bitrate video filled it
        // and every OTHER room's ffmpeg then died with ENOSPC. -fs stops this
        // room's writer at its own ceiling instead.
        cmd.arg("-fs").arg(self.max_bytes.to_string());
        cmd.arg(PLAYLIST_NAME);
        cmd
    }
}

/// Append one input (its headers, reconnect flags, optional `-ss`, then `-i`).
/// Order matters: all of these are *input* options and must precede `-i`.
fn add_input(cmd: &mut Command, offset: f64, url: &str, headers: &[(String, String)]) {
    if !headers.is_empty() {
        // ffmpeg wants CRLF-separated "Key: Value" lines in a single arg — so a
        // \r or \n inside a key or value injects extra headers into ffmpeg's
        // outbound request. These pairs come from the resolver, i.e. from
        // yt-dlp's extraction of a user-pasted page, so they are not trusted.
        // Drop any pair containing a control character rather than silently
        // sanitizing it: a header that needs one is a header we should not send.
        let mut blob = String::new();
        for (k, v) in headers {
            if has_control_chars(k) || has_control_chars(v) || k.is_empty() {
                tracing::warn!("dropping stream header with control characters: {k:?}");
                continue;
            }
            blob.push_str(k);
            blob.push_str(": ");
            blob.push_str(v);
            blob.push_str("\r\n");
        }
        if !blob.is_empty() {
            cmd.arg("-headers").arg(blob);
        }
    }
    // Survive transient drops on signed CDN URLs (http/https inputs only).
    if url.starts_with("http") {
        cmd.arg("-reconnect")
            .arg("1")
            .arg("-reconnect_streamed")
            .arg("1")
            .arg("-reconnect_delay_max")
            .arg("5");
    }
    // Input-side seek: with `-c:v copy` ffmpeg starts at the nearest keyframe and
    // shifts output timestamps to ~0, which is exactly the offset model the
    // client maps against. Skip for ~0 so live/short sources aren't perturbed.
    if offset > 0.25 {
        cmd.arg("-ss").arg(format!("{offset:.3}"));
    }
    cmd.arg("-i").arg(url);
}

/// Drain ffmpeg's stderr — an undrained pipe blocks the child once it fills —
/// keeping the last few lines for the log.
fn collect_stderr_tail(stderr: ChildStderr) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line: String = redact_urls(String::from_utf8_lossy(&buf).trim_end())
                        .chars()
                        .take(STDERR_LINE_MAX)
                        .collect();
                    if line.is_empty() {
                        continue;
                    }
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        }
        tail.into()
    })
}

/// Reduce every URL in an ffmpeg line to its scheme and host. ffmpeg quotes
/// the input URL in its errors, and a media URL can carry signed CDN tokens
/// and says what someone was watching; the privacy policy promises video URLs
/// stay in memory, and the host is all a diagnosis needs.
fn redact_urls(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        let start = match (rest.find("http://"), rest.find("https://")) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => break,
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
        let token = &tail[..end];
        // Keep punctuation ffmpeg puts right after the URL ("…mp4: Server …").
        let bare = token.trim_end_matches([':', ',', ';', ')', '\'', '"']);
        match url::Url::parse(bare) {
            Ok(u) => {
                out.push_str(u.scheme());
                out.push_str("://");
                out.push_str(u.host_str().unwrap_or("?"));
                out.push_str("/…");
            }
            Err(_) => out.push_str("<url>"),
        }
        out.push_str(&token[bare.len()..]);
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// ` — ffmpeg said: …` for a log line, or nothing when it said nothing.
fn describe_tail(tail: &[String]) -> String {
    if tail.is_empty() {
        String::new()
    } else {
        format!(" — ffmpeg said: {}", tail.join(" | "))
    }
}

/// Owns the child: reaps it on natural exit, kills it on signal. The child is
/// dropped at the end of this task, so `kill_on_drop` is the final backstop.
async fn supervise(
    mut child: Child,
    kill_rx: oneshot::Receiver<()>,
    stderr_tail: Option<tokio::task::JoinHandle<Vec<String>>>,
    room_dir: PathBuf,
    state: Arc<AppState>,
    room_id: String,
    generation: u64,
) {
    tokio::select! {
        _ = kill_rx => {
            // Explicit, awaited kill (per the lifecycle contract).
            let _ = child.kill().await;
        }
        status = child.wait() => {
            // The pipe closes with the child, so this finishes promptly.
            let tail = match stderr_tail {
                Some(handle) => handle.await.unwrap_or_default(),
                None => Vec::new(),
            };
            match status {
                // A clean exit on a finite source means the event playlist is
                // now a complete VOD — if the files are really there. On a full
                // streams volume ffmpeg's HLS muxer writes empty segments and an
                // empty playlist, says nothing at -loglevel warning, and still
                // exits 0; the room then sat on a frozen player with no error.
                Ok(s) if s.success() => {
                    let dir = room_dir.clone();
                    let verdict = tokio::task::spawn_blocking(move || check_output(&dir))
                        .await
                        .unwrap_or_else(|e| Err(format!("its output could not be checked ({e})")));
                    if let Err(why) = verdict {
                        tracing::warn!(
                            "stream {room_id}: ffmpeg exited cleanly but {why} — is the streams \
                             volume full? (raise STREAMS_TMPFS_SIZE){}",
                            describe_tail(&tail)
                        );
                        mark_error(&state, &room_id, generation).await;
                    }
                }
                Ok(s) => {
                    tracing::warn!("stream {room_id}: ffmpeg exited {s}{}", describe_tail(&tail));
                    mark_error(&state, &room_id, generation).await;
                }
                Err(e) => {
                    tracing::warn!("stream {room_id}: waiting on ffmpeg failed: {e}");
                    mark_error(&state, &room_id, generation).await;
                }
            }
            state.streams.forget(&room_id, generation).await;
        }
    }
}

/// Why a finished stream's output cannot be played, if it cannot: the
/// playlist must list at least one segment, and every segment it lists must
/// exist and be non-empty.
fn check_output(room_dir: &Path) -> Result<(), String> {
    let playlist = std::fs::read_to_string(room_dir.join(PLAYLIST_NAME))
        .map_err(|e| format!("its playlist is unreadable ({e})"))?;
    let mut listed = 0usize;
    for name in playlist.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        listed += 1;
        // ffmpeg writes bare file names; anything else is not ours to stat.
        if name.contains(['/', '\\']) {
            continue;
        }
        match std::fs::metadata(room_dir.join(name)) {
            Ok(meta) if meta.len() > 0 => {}
            Ok(_) => return Err(format!("segment {name} is empty")),
            Err(_) => return Err(format!("segment {name} is missing")),
        }
    }
    if listed == 0 {
        return Err("its playlist lists no segments".to_string());
    }
    Ok(())
}

/// Poll for a playable playlist, then flip the room to ready. Gives up (marks
/// error) after the configured timeout, and bails early if superseded.
async fn poll_ready(
    playlist: PathBuf,
    state: Arc<AppState>,
    room_id: String,
    generation: u64,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;
    loop {
        if playlist_ready(&playlist).await {
            mark_ready(&state, &room_id, generation).await;
            return;
        }
        match current_generation_is(&state, &room_id, generation).await {
            Some(true) => {}
            // Room gone or a newer stream took over — stop polling.
            _ => return,
        }
        if Instant::now() >= deadline {
            tracing::warn!("stream {room_id}: no playlist within {timeout:?}");
            mark_error(&state, &room_id, generation).await;
            return;
        }
        sleep(POLL_INTERVAL).await;
    }
}

/// Ready once ffmpeg has written the playlist *and* listed at least one segment.
async fn playlist_ready(path: &Path) -> bool {
    match tokio::fs::read_to_string(path).await {
        Ok(body) => body.contains("#EXTINF"),
        Err(_) => false,
    }
}

async fn mark_ready(state: &AppState, room_id: &str, generation: u64) {
    let mut rooms = state.rooms.write().await;
    if let Some(room) = rooms.get_mut(room_id) {
        if room.mark_stream_ready(generation) {
            tracing::info!("stream {room_id}: ready gen={generation}");
            room.broadcast_state(None);
        }
    }
}

async fn mark_error(state: &AppState, room_id: &str, generation: u64) {
    let mut rooms = state.rooms.write().await;
    if let Some(room) = rooms.get_mut(room_id) {
        if room.mark_stream_error(generation) {
            room.broadcast_state(None);
        }
    }
}

/// `Some(true)` if the room exists and its current stream is still `generation`;
/// `Some(false)` if it exists but moved on; `None` if the room is gone.
async fn current_generation_is(state: &AppState, room_id: &str, generation: u64) -> Option<bool> {
    let rooms = state.rooms.read().await;
    let room = rooms.get(room_id)?;
    Some(room.stream_generation() == Some(generation))
}

// ---------------------------------------------------------------------------
// Source preparation (resolver call + direct-URL fast path)
// ---------------------------------------------------------------------------

/// New resolver contract (see `resolver/app.py`).
#[derive(Deserialize)]
struct ResolverResponse {
    video_url: String,
    #[serde(default)]
    audio_url: Option<String>,
    #[serde(default)]
    video_headers: HashMap<String, String>,
    #[serde(default)]
    audio_headers: HashMap<String, String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    is_live: bool,
}

/// What ffmpeg should mux, plus metadata the resolver discovered (title/live).
pub struct PreparedSource {
    pub source: StreamSource,
    pub title: Option<String>,
    pub is_live: bool,
}

/// Turn a room's media into ffmpeg inputs. Direct media URLs (HLS / known file
/// extensions) are fed straight in; generic page URLs go through the yt-dlp
/// resolver to extract separate video+audio + the headers needed to fetch them.
pub async fn prepare_source(state: &AppState, media: &Media) -> Result<PreparedSource, String> {
    // Scheme gate first, and unconditionally. `sanitize_url` already enforces
    // http(s) on the inbound WS path, but that guarantee lives in ws.rs and
    // this fn is `pub`; re-asserting it here is what stops a future caller from
    // handing ffmpeg a `file:`/`concat:` input. Note `allow_private_urls` must
    // NOT skip this: that flag is about reaching a LAN Jellyfin/NAS.
    if !is_allowed_stream_url(&media.source) {
        return Err("URL scheme is not allowed".to_string());
    }
    // SSRF gate: everything below ends with a server-side fetch of the pasted
    // URL (ffmpeg directly, or yt-dlp via the resolver), so refuse hosts that
    // resolve to private/internal addresses unless explicitly allowed.
    if !state.config.allow_private_urls && !crate::media::is_public_target(&media.source).await {
        return Err("URL host is not allowed (private/unresolvable address)".to_string());
    }

    // Direct, already-playable URL → single ffmpeg input, no resolver hop.
    if media.kind == "hls" || crate::media::is_direct_media_url(&media.source) {
        return Ok(PreparedSource {
            source: StreamSource::single(media.source.clone(), Vec::new()),
            title: None,
            is_live: media.is_live,
        });
    }

    // Generic page URL → resolver. With no resolver configured, fall back to a
    // best-effort single input (ffmpeg will most likely fail and mark error).
    let Some(base) = state.config.resolver_url.clone() else {
        return Ok(PreparedSource {
            source: StreamSource::single(media.source.clone(), Vec::new()),
            title: None,
            is_live: media.is_live,
        });
    };

    let endpoint = format!("{base}/resolve");
    let resp = state
        .http
        .get(&endpoint)
        .query(&[("url", &media.source)])
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("resolver unavailable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("resolver returned {}", resp.status()));
    }
    let body: ResolverResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad resolver response: {e}"))?;

    let source = StreamSource {
        video_url: body.video_url,
        video_headers: into_pairs(body.video_headers),
        audio_url: body.audio_url.filter(|u| !u.is_empty()),
        audio_headers: into_pairs(body.audio_headers),
    };
    if source.video_url.is_empty() {
        return Err("resolver returned no video url".to_string());
    }

    // The gate above covered `media.source` — the page URL the user pasted.
    // These URLs are different: yt-dlp extracted them *from* that page, so they
    // are attacker-influenced and have never been checked. Without this, a
    // crafted page whose extractor yields `file:///etc/passwd` or
    // `http://watchsync-server:3000/...` hands that straight to `ffmpeg -i`.
    for url in [Some(&source.video_url), source.audio_url.as_ref()]
        .into_iter()
        .flatten()
    {
        if !is_allowed_stream_url(url) {
            return Err("resolver returned a disallowed stream url".to_string());
        }
        if !state.config.allow_private_urls && !crate::media::is_public_target(url).await {
            return Err("resolver returned a private/unresolvable stream url".to_string());
        }
    }
    Ok(PreparedSource {
        source,
        title: body.title.filter(|t| !t.trim().is_empty()),
        is_live: body.is_live,
    })
}

fn into_pairs(map: HashMap<String, String>) -> Vec<(String, String)> {
    map.into_iter().collect()
}

/// `true` if `s` holds any ASCII control character (CR/LF included).
fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_control())
}

/// `true` for a URL that is safe to hand to `ffmpeg -i`. Scheme-only check;
/// the host still has to clear `media::is_public_target`. Deliberately an
/// allow-list: ffmpeg speaks a long tail of protocols (`file:`, `concat:`,
/// `subfile:`, `pipe:`, …) that must never come from an untrusted source.
fn is_allowed_stream_url(url: &str) -> bool {
    if has_control_chars(url) || url.len() > 8192 {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ffmpeg speaks a long tail of protocols beyond http(s). Resolver output
    /// is derived from a user-pasted page, so it is untrusted input to `-i`.
    #[test]
    fn stream_url_scheme_allowlist() {
        for url in [
            "file:///etc/passwd",
            "concat:/etc/passwd|/etc/shadow",
            "subfile,,start,0,end,100,,:/etc/passwd",
            "pipe:0",
            "ftp://example.com/x.mp4",
            "data:video/mp4;base64,AAAA",
            "rtmp://example.com/live",
            "",
        ] {
            assert!(!is_allowed_stream_url(url), "{url} must be rejected");
        }
        for url in [
            "http://example.com/a.mp4",
            "https://example.com/a.m3u8?sig=abc",
            "HTTPS://EXAMPLE.COM/A.MP4",
        ] {
            assert!(is_allowed_stream_url(url), "{url} must be allowed");
        }
    }

    #[test]
    fn stream_url_rejects_control_chars_and_overlong() {
        assert!(!is_allowed_stream_url("http://example.com/a\r\nHost: evil"));
        assert!(!is_allowed_stream_url("http://example.com/a\n"));
        assert!(!is_allowed_stream_url(&format!("https://e.com/{}", "a".repeat(9000))));
    }

    /// A \r or \n in a resolver-supplied header injects extra headers into
    /// ffmpeg's outbound request, so such pairs are dropped entirely.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("watchsync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PLAYLIST: &str = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg_00000.ts\n#EXTINF:4.0,\nseg_00001.ts\n#EXT-X-ENDLIST\n";

    #[test]
    fn finished_output_with_real_segments_passes() {
        let dir = scratch_dir("ok");
        std::fs::write(dir.join(PLAYLIST_NAME), PLAYLIST).unwrap();
        std::fs::write(dir.join("seg_00000.ts"), b"x").unwrap();
        std::fs::write(dir.join("seg_00001.ts"), b"x").unwrap();
        assert_eq!(check_output(&dir), Ok(()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What ffmpeg leaves behind on a full volume, while exiting 0.
    #[test]
    fn empty_playlist_or_segments_fail_the_check() {
        let dir = scratch_dir("full");
        std::fs::write(dir.join(PLAYLIST_NAME), "").unwrap();
        assert!(check_output(&dir).unwrap_err().contains("no segments"));

        std::fs::write(dir.join(PLAYLIST_NAME), PLAYLIST).unwrap();
        std::fs::write(dir.join("seg_00000.ts"), b"x").unwrap();
        std::fs::write(dir.join("seg_00001.ts"), b"").unwrap();
        assert!(check_output(&dir).unwrap_err().contains("seg_00001.ts is empty"));

        std::fs::remove_file(dir.join("seg_00001.ts")).unwrap();
        assert!(check_output(&dir).unwrap_err().contains("missing"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_playlist_fails_the_check() {
        let dir = scratch_dir("none");
        assert!(check_output(&dir).unwrap_err().contains("unreadable"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logged_ffmpeg_output_keeps_only_the_host_of_urls() {
        assert_eq!(
            redact_urls(
                "https://cdn.example.com/v/abc.mp4?sig=SECRET&exp=1: Server returned 403 Forbidden"
            ),
            "https://cdn.example.com/…: Server returned 403 Forbidden"
        );
        assert_eq!(
            redact_urls("Opening 'http://a.example/x.ts' and https://b.example/y.m3u8 failed"),
            "Opening 'http://a.example/…' and https://b.example/… failed"
        );
        assert_eq!(redact_urls("[https @ 0x5b] HTTP error 403 Forbidden"), "[https @ 0x5b] HTTP error 403 Forbidden");
        assert_eq!(redact_urls("bad https://[oops"), "bad <url>");
    }

    #[test]
    fn control_chars_detected_in_header_pairs() {
        assert!(has_control_chars("evil\r\nX-Injected: 1"));
        assert!(has_control_chars("line\nbreak"));
        assert!(has_control_chars("tab\there"));
        assert!(!has_control_chars("Mozilla/5.0 (X11; Linux x86_64)"));
        assert!(!has_control_chars("https://www.youtube.com/"));
    }
}

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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{sleep, Instant};

use crate::protocol::Media;
use crate::state::AppState;

/// Playlist filename written into each room dir. Segment URIs in it are relative
/// (`seg_00001.ts`), so they resolve under the same `/api/streams/{room}/` path.
const PLAYLIST_NAME: &str = "index.m3u8";
const SEGMENT_PATTERN: &str = "seg_%05d.ts";
const POLL_INTERVAL: Duration = Duration::from_millis(250);

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
    ) -> Self {
        StreamManager {
            dir,
            hls_segment_sec: hls_segment_sec.max(1),
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

        let mut sessions = self.sessions.lock().await;
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
        // Fresh, empty room dir on the RAM disk. (tmpfs ops are ~instant.)
        let _ = std::fs::remove_dir_all(&room_dir);
        if let Err(e) = std::fs::create_dir_all(&room_dir) {
            drop(sessions);
            tracing::error!("stream {room_id}: failed to create {room_dir:?}: {e}");
            mark_error(&state, &room_id, generation).await;
            return;
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                drop(sessions);
                tracing::error!("stream {room_id}: ffmpeg spawn failed: {e}");
                mark_error(&state, &room_id, generation).await;
                return;
            }
        };
        tracing::info!("stream {room_id}: ffmpeg gen={generation} offset={offset:.1}s live={live}");

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
        tokio::spawn(supervise(child, kill_rx, state.clone(), room_id.clone(), generation));
        let playlist = room_dir.join(PLAYLIST_NAME);
        tokio::spawn(poll_ready(playlist, state, room_id, generation, self.ready_timeout));
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
            .stderr(Stdio::null())
            .arg("-nostdin")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("warning")
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
            // whole timeline stays seekable off the (size-capped) RAM disk.
            cmd.arg("-hls_playlist_type")
                .arg("event")
                .arg("-hls_flags")
                .arg("independent_segments");
        }
        cmd.arg(PLAYLIST_NAME);
        cmd
    }
}

/// Append one input (its headers, reconnect flags, optional `-ss`, then `-i`).
/// Order matters: all of these are *input* options and must precede `-i`.
fn add_input(cmd: &mut Command, offset: f64, url: &str, headers: &[(String, String)]) {
    if !headers.is_empty() {
        // ffmpeg wants CRLF-separated "Key: Value" lines in a single arg.
        let mut blob = String::new();
        for (k, v) in headers {
            blob.push_str(k);
            blob.push_str(": ");
            blob.push_str(v);
            blob.push_str("\r\n");
        }
        cmd.arg("-headers").arg(blob);
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

/// Owns the child: reaps it on natural exit, kills it on signal. The child is
/// dropped at the end of this task, so `kill_on_drop` is the final backstop.
async fn supervise(
    mut child: Child,
    kill_rx: oneshot::Receiver<()>,
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
            match status {
                // Clean EOF on a finite source: the event playlist is now a
                // complete VOD — nothing to do.
                Ok(s) if s.success() => {}
                Ok(s) => {
                    tracing::warn!("stream {room_id}: ffmpeg exited {s}");
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
    Ok(PreparedSource {
        source,
        title: body.title.filter(|t| !t.trim().is_empty()),
        is_live: body.is_live,
    })
}

fn into_pairs(map: HashMap<String, String>) -> Vec<(String, String)> {
    map.into_iter().collect()
}

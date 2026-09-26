import { client } from '../client';
import { useStore } from '../store';

export default function UsersPanel() {
  const users = useStore((s) => s.users);
  const isHost = useStore((s) => s.isHost);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <ul className="flex flex-1 list-none flex-col gap-1.5 overflow-y-auto p-0">
        {users.map((u) => {
          const isSelf = u.client_id === client.clientId;
          const canModerate = isHost && !isSelf;
          return (
            <li
              key={u.client_id}
              className={`flex items-center justify-between gap-2 rounded-lg bg-surface2 px-3 py-2.5 ${
                u.disconnected ? 'opacity-50' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: u.color }} />
                <span className="truncate">
                  {u.nickname}
                  {isSelf ? ' (you)' : ''}
                </span>
              </span>
              <span className="flex flex-shrink-0 items-center gap-1.5">
                {u.disconnected && (
                  <span className="rounded-full border border-border bg-bg px-1.5 py-px text-[0.7rem] text-dim">away</span>
                )}
                {u.buffering && (
                  <span className="rounded-full bg-warn px-1.5 py-px text-[0.7rem] text-black">buffering</span>
                )}
                {u.is_host && (
                  <span className="rounded-full bg-accent px-1.5 py-px text-[0.7rem] font-semibold text-white">HOST</span>
                )}
                {canModerate && (
                  <ModerationMenu clientId={u.client_id} nickname={u.nickname} away={u.disconnected} />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Host-only controls for a single user: hand over host, kick, ban. */
function ModerationMenu({ clientId, nickname, away }: { clientId: string; nickname: string; away: boolean }) {
  function makeHost() {
    if (!window.confirm(`Make ${nickname} the host? You'll lose host controls.`)) return;
    if (client.transferHost(clientId)) useStore.getState().showToast(`${nickname} is now the host`);
  }
  function kick() {
    client.kickUser(clientId);
    useStore.getState().showToast(`Removed ${nickname}`);
  }
  function ban() {
    if (!window.confirm(`Ban ${nickname}? They won't be able to rejoin this room.`)) return;
    client.banUser(clientId);
    useStore.getState().showToast(`Banned ${nickname}`);
  }
  const btn =
    'rounded border border-border bg-transparent px-1.5 py-px text-[0.7rem] text-dim transition hover:border-danger hover:text-danger';
  return (
    <span className="flex items-center gap-1">
      {!away && (
        <button
          className={`${btn} hover:!border-accent hover:!text-accent`}
          title={`Make ${nickname} the host`}
          onClick={makeHost}
        >
          Host
        </button>
      )}
      <button className={btn} title={`Remove ${nickname}`} onClick={kick}>
        Kick
      </button>
      <button className={btn} title={`Ban ${nickname}`} onClick={ban}>
        Ban
      </button>
    </span>
  );
}

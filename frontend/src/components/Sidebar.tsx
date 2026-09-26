import { useStore, type Tab } from '../store';
import ChatPanel from './ChatPanel';
import QueuePanel from './QueuePanel';
import UsersPanel from './UsersPanel';

export default function Sidebar() {
  const activeTab = useStore((s) => s.activeTab);
  const unread = useStore((s) => s.unread);
  const queueCount = useStore((s) => s.queue.length);
  const userCount = useStore((s) => s.users.filter((u) => !u.disconnected).length);

  function select(tab: Tab) {
    const store = useStore.getState();
    store.setActiveTab(tab);
    if (tab === 'chat') store.clearUnread();
  }

  const tab = (id: Tab, label: string, badge: number, danger = false) => {
    const active = activeTab === id;
    return (
      <button
        role="tab"
        id={`tab-${id}`}
        aria-selected={active}
        aria-controls={`panel-${id}`}
        onClick={() => select(id)}
        className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-3.5 transition ${
          active ? 'border-accent text-text' : 'border-transparent text-dim hover:text-text'
        }`}
      >
        {label}
        {(badge > 0 || id !== 'chat') && (
          <span
            className={`rounded-full px-1.5 py-px text-xs ${
              danger ? 'bg-danger text-white' : active ? 'bg-accent text-white' : 'bg-surface2 text-dim'
            }`}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="flex min-h-0 flex-col border-t border-border bg-surface lg:col-start-2 lg:row-start-2 lg:border-l lg:border-t-0 h-[55vh] lg:h-auto">
      <div role="tablist" aria-label="Room panels" className="flex border-b border-border">
        {tab('chat', 'Chat', unread, true)}
        {tab('queue', 'Queue', queueCount)}
        {tab('users', 'Users', userCount)}
      </div>
      {activeTab === 'chat' && (
        <div role="tabpanel" id="panel-chat" aria-labelledby="tab-chat" className="contents">
          <ChatPanel />
        </div>
      )}
      {activeTab === 'queue' && (
        <div role="tabpanel" id="panel-queue" aria-labelledby="tab-queue" className="contents">
          <QueuePanel />
        </div>
      )}
      {activeTab === 'users' && (
        <div role="tabpanel" id="panel-users" aria-labelledby="tab-users" className="contents">
          <UsersPanel />
        </div>
      )}
    </aside>
  );
}

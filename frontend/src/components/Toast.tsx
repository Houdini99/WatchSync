import { useStore } from '../store';

export default function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-[200] max-w-[90vw] -translate-x-1/2 rounded-lg border border-border bg-surface2 px-4 py-2.5 text-sm shadow-panel">
      {toast}
    </div>
  );
}

import * as Toast from "@radix-ui/react-toast";
import { createContext, type ReactNode, useContext, useState } from "react";

export interface Notice {
  title: string;
  description?: string;
  tone: "ok" | "bad";
  /** A button in the notice, such as Reload after a conflict. */
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<(notice: Notice) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function Toaster({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<(Notice & { id: number })[]>([]);
  const show = (notice: Notice) =>
    setNotices((list) => [
      ...list,
      { ...notice, id: Date.now() + Math.random() },
    ]);
  return (
    <Toast.Provider swipeDirection="right">
      <ToastContext.Provider value={show}>{children}</ToastContext.Provider>
      {notices.map((notice) => (
        <Toast.Root
          key={notice.id}
          className={`toast ${notice.tone}`}
          type={notice.tone === "bad" ? "foreground" : "background"}
          onOpenChange={(open) => {
            if (!open)
              setNotices((list) => list.filter((n) => n.id !== notice.id));
          }}
        >
          <Toast.Title className="font-semibold">{notice.title}</Toast.Title>
          {notice.description && (
            <Toast.Description className="text-muted">
              {notice.description}
            </Toast.Description>
          )}
          {notice.action && (
            <Toast.Action
              altText={notice.action.label}
              className="ghost justify-self-start"
              onClick={notice.action.onClick}
            >
              {notice.action.label}
            </Toast.Action>
          )}
          <Toast.Close className="toast-close" aria-label="Dismiss">
            ×
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className="toast-viewport" />
    </Toast.Provider>
  );
}

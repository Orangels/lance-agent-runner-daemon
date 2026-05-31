import type { DemoChatMessage } from '../chat/chat-types.js';

interface UserMessageProps {
  message: DemoChatMessage;
}

export function UserMessage({ message }: UserMessageProps) {
  return (
    <article className="msg user">
      <div className="msg-meta">
        <span>{message.runMode ?? 'prompt'}</span>
      </div>
      <div className="user-bubble">{message.content}</div>
    </article>
  );
}

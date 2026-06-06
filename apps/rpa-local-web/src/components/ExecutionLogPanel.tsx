export interface ExecutionTimelineEvent {
  type: string;
  executionId: string;
  timestamp: string;
  stepId?: string;
  stream?: 'stdout' | 'stderr';
  message?: string;
  status?: string;
  exitCode?: number | null;
  sequence?: number;
}

export interface ExecutionLogPanelProps {
  events: ExecutionTimelineEvent[];
  stdout: string;
  stderr: string;
}

const maxVisibleEvents = 200;

function eventDetail(event: ExecutionTimelineEvent): string {
  if (event.message) return event.message;
  if (event.status && typeof event.exitCode === 'number') return `${event.status} (${event.exitCode})`;
  if (event.status) return event.status;
  if (event.stream) return event.stream;
  return '';
}

export function ExecutionLogPanel({ events, stdout, stderr }: ExecutionLogPanelProps) {
  const visibleEvents = events.slice(-maxVisibleEvents);

  return (
    <section className="rpa-execution-log-panel" aria-label="Execution logs">
      <div className="rpa-execution-log-panel__header">
        <h3>Logs</h3>
        <span className="rpa-execution-log-panel__count">{visibleEvents.length}</span>
      </div>

      <div className="rpa-execution-log-panel__timeline" aria-label="Event timeline">
        {visibleEvents.length === 0 ? (
          <p className="rpa-execution-log-panel__empty">No events yet.</p>
        ) : (
          <ol className="rpa-execution-log-panel__events">
            {visibleEvents.map((event, index) => {
              const detail = eventDetail(event);
              const key = event.sequence ?? `${event.timestamp}-${event.type}-${index}`;

              return (
                <li key={key} data-testid={`rpa-event-${index}`} className="rpa-execution-log-panel__event">
                  <time className="rpa-execution-log-panel__timestamp" dateTime={event.timestamp}>
                    {event.timestamp}
                  </time>
                  <span className="rpa-execution-log-panel__type">{event.type}</span>
                  {event.stepId ? <span className="rpa-execution-log-panel__step">{event.stepId}</span> : null}
                  {detail ? <span className="rpa-execution-log-panel__message">{detail}</span> : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="rpa-execution-log-panel__streams">
        <label className="rpa-execution-log-panel__stream">
          <span>stdout</span>
          <textarea aria-label="stdout" readOnly value={stdout} />
        </label>
        <label className="rpa-execution-log-panel__stream">
          <span>stderr</span>
          <textarea aria-label="stderr" readOnly value={stderr} />
        </label>
      </div>
    </section>
  );
}

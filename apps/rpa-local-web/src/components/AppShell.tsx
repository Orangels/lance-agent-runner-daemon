import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, Braces, FolderKanban, PlaySquare, Settings, WandSparkles } from 'lucide-react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type { RpaConfigResponse, RpaDaemonHealthResponse } from '../shared/rpa-api-types.js';
import { CodegenWorkspace } from './CodegenWorkspace.js';
import { FlowAssetsWorkspace } from './FlowAssetsWorkspace.js';
import { NaturalLanguageWorkspace } from './NaturalLanguageWorkspace.js';
import { RuntimeVerificationWorkspace } from './RuntimeVerificationWorkspace.js';
import { StatusBadge } from './StatusBadge.js';

export type RpaSectionId = 'codegen' | 'natural-language' | 'flows' | 'executions' | 'settings';

export interface RpaSection {
  id: RpaSectionId;
  label: string;
  title: string;
  description: string;
  icon: ReactNode;
}

export const rpaSections: RpaSection[] = [
  {
    id: 'codegen',
    label: 'Codegen 加固',
    title: 'Playwright codegen 录制后加固',
    description: '启动本地 codegen 录制，交给 playwright-rpa-harden skill 生成 DSL、加固脚本和报告。',
    icon: <Braces aria-hidden="true" />,
  },
  {
    id: 'natural-language',
    label: '自然语言生成',
    title: '用业务描述生成 RPA 流程',
    description: '收集目标 URL、业务步骤和确认信息，交给 rpa-script-generate skill 生成可验证流程。',
    icon: <WandSparkles aria-hidden="true" />,
  },
  {
    id: 'flows',
    label: 'Flows',
    title: '流程资产',
    description: '查看已生成流程、执行参数、导入导出包和本地验证状态。',
    icon: <FolderKanban aria-hidden="true" />,
  },
  {
    id: 'executions',
    label: 'Executions',
    title: '执行与验证',
    description: '后续展示 verify/run 状态、步骤截图、日志、trace、录像和下载产物。',
    icon: <PlaySquare aria-hidden="true" />,
  },
  {
    id: 'settings',
    label: 'Settings',
    title: '本地配置',
    description: '查看 daemon 地址、profile、浏览器录制命令、本地 storage root 和连接状态。',
    icon: <Settings aria-hidden="true" />,
  },
];

export interface AppShellProps {
  activeSectionId: RpaSectionId;
  onSectionChange: (sectionId: RpaSectionId) => void;
}

export function AppShell({ activeSectionId, onSectionChange }: AppShellProps) {
  const activeSection = rpaSections.find((section) => section.id === activeSectionId) ?? rpaSections[0]!;
  const apiClient = useMemo(() => new RpaApiClient(), []);
  const [config, setConfig] = useState<RpaConfigResponse | null>(null);
  const [daemonHealth, setDaemonHealth] = useState<RpaDaemonHealthResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const [nextConfig, nextDaemonHealth] = await Promise.all([
          apiClient.getConfig(),
          apiClient.getDaemonHealth(),
        ]);
        if (cancelled) return;
        setConfig(nextConfig);
        setDaemonHealth(nextDaemonHealth);
      } catch (error) {
        if (cancelled) return;
        setStatusError(error instanceof Error ? error.message : 'Unable to load local configuration.');
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    }

    void loadStatus();

    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const daemonBadge = daemonBadgeState({ daemonHealth, loading: statusLoading, statusError });

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>RPA Local Web</h1>
          <p>本地 B/S 形态的脚本生成、加固和执行工作台</p>
        </div>
        <div className="topbar__status">
          <StatusBadge tone="ready">Local</StatusBadge>
          <StatusBadge tone={daemonBadge.tone}>{daemonBadge.label}</StatusBadge>
        </div>
      </header>

      <section className="workspace">
        <nav className="sidebar" aria-label="RPA workflows">
          <div className="sidebar__brand">
            <Bot aria-hidden="true" />
            <span>RPA MVP</span>
          </div>
          <div role="tablist" aria-label="RPA sections" className="section-tabs">
            {rpaSections.map((section) => (
              <button
                key={section.id}
                type="button"
                role="tab"
                aria-selected={section.id === activeSection.id}
                className="section-tab"
                onClick={() => onSectionChange(section.id)}
              >
                {section.icon}
                <span>{section.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <section className="content-panel" aria-labelledby="section-title">
          <div className="content-panel__heading">
            <div>
              <h2 id="section-title">{activeSection.title}</h2>
              <p>{activeSection.description}</p>
            </div>
            <StatusBadge
              tone={
                activeSection.id === 'settings' || activeSection.id === 'executions' || activeSection.id === 'flows'
                  ? 'ready'
                  : 'warning'
              }
            >
              {activeSection.id === 'settings'
                ? 'Configured'
                : activeSection.id === 'executions' || activeSection.id === 'flows'
                  ? 'Workbench'
                  : 'Skeleton'}
            </StatusBadge>
          </div>

          {activeSection.id === 'codegen' ? (
            <CodegenWorkspace />
          ) : activeSection.id === 'natural-language' ? (
            <NaturalLanguageWorkspace />
          ) : activeSection.id === 'flows' ? (
            <FlowAssetsWorkspace />
          ) : activeSection.id === 'executions' ? (
            <RuntimeVerificationWorkspace />
          ) : (
            <SettingsWorkspace
              config={config}
              daemonHealth={daemonHealth}
              loading={statusLoading}
              statusError={statusError}
            />
          )}
        </section>
      </section>
    </main>
  );
}

interface DaemonBadgeInput {
  daemonHealth: RpaDaemonHealthResponse | null;
  loading: boolean;
  statusError: string | null;
}

function daemonBadgeState(input: DaemonBadgeInput): { label: string; tone: 'neutral' | 'ready' | 'warning' } {
  if (input.loading) return { label: 'Daemon checking', tone: 'neutral' };
  if (input.statusError) return { label: 'Daemon unknown', tone: 'warning' };
  if (input.daemonHealth?.daemonReachable) return { label: 'Daemon connected', tone: 'ready' };
  return { label: 'Daemon unavailable', tone: 'warning' };
}

interface SettingsWorkspaceProps {
  config: RpaConfigResponse | null;
  daemonHealth: RpaDaemonHealthResponse | null;
  loading: boolean;
  statusError: string | null;
}

function SettingsWorkspace({ config, daemonHealth, loading, statusError }: SettingsWorkspaceProps) {
  const daemonCommand = config ? [config.codegenCommand, ...config.codegenArgs].join(' ') : 'Loading';
  const daemonStatus = daemonHealth?.daemonReachable ? 'Connected' : 'Unavailable';
  const daemonDetail = daemonHealth?.daemonReachable
    ? `HTTP ${daemonHealth.status ?? 200}`
    : daemonHealth?.error ?? statusError ?? 'Daemon health has not been loaded yet.';

  return (
    <div className="settings-workspace">
      <section className="settings-panel" aria-labelledby="settings-daemon-heading">
        <div className="settings-panel__heading">
          <h3 id="settings-daemon-heading">Daemon connection</h3>
          <StatusBadge tone={daemonHealth?.daemonReachable ? 'ready' : 'warning'}>
            {loading ? 'Checking' : daemonStatus}
          </StatusBadge>
        </div>
        <dl className="settings-list">
          <div>
            <dt>Daemon base URL</dt>
            <dd>{config?.daemonBaseUrl ?? 'Loading'}</dd>
          </div>
          <div>
            <dt>Default profile</dt>
            <dd>{config?.defaultProfileId ?? 'Loading'}</dd>
          </div>
          <div>
            <dt>Daemon configured</dt>
            <dd>{config ? (config.daemonConfigured ? 'Yes' : 'No') : 'Loading'}</dd>
          </div>
          <div>
            <dt>Health detail</dt>
            <dd>{daemonDetail}</dd>
          </div>
        </dl>
      </section>

      <section className="settings-panel" aria-labelledby="settings-local-heading">
        <div className="settings-panel__heading">
          <h3 id="settings-local-heading">Local runtime</h3>
          <StatusBadge tone="ready">{config?.mode ?? 'Loading'}</StatusBadge>
        </div>
        <dl className="settings-list">
          <div>
            <dt>Storage root</dt>
            <dd>{config?.storageRoot ?? 'Loading'}</dd>
          </div>
          <div>
            <dt>Codegen command</dt>
            <dd>{daemonCommand}</dd>
          </div>
          <div>
            <dt>Browser/display</dt>
            <dd>Configured by the server environment used to start RPA Local Web.</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

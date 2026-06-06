import type { ReactNode } from 'react';
import { Bot, Braces, FolderKanban, PlaySquare, Settings, WandSparkles } from 'lucide-react';
import { CodegenWorkspace } from './CodegenWorkspace.js';
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
    description: '后续展示已生成流程、参数表单、导入导出包和版本记录。',
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
    description: '后续配置 daemon 地址、profile、浏览器策略、下载目录和调试采集模式。',
    icon: <Settings aria-hidden="true" />,
  },
];

export interface AppShellProps {
  activeSectionId: RpaSectionId;
  onSectionChange: (sectionId: RpaSectionId) => void;
}

export function AppShell({ activeSectionId, onSectionChange }: AppShellProps) {
  const activeSection = rpaSections.find((section) => section.id === activeSectionId) ?? rpaSections[0]!;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>RPA Local Web</h1>
          <p>本地 B/S 形态的脚本生成、加固和执行工作台</p>
        </div>
        <div className="topbar__status">
          <StatusBadge tone="ready">Local</StatusBadge>
          <StatusBadge tone="neutral">Daemon</StatusBadge>
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
            <StatusBadge tone={activeSection.id === 'executions' ? 'ready' : 'warning'}>
              {activeSection.id === 'executions' ? 'Workbench' : 'Skeleton'}
            </StatusBadge>
          </div>

          {activeSection.id === 'codegen' ? (
            <CodegenWorkspace />
          ) : activeSection.id === 'executions' ? (
            <RuntimeVerificationWorkspace />
          ) : (
            <PlaceholderGrid />
          )}
        </section>
      </section>
    </main>
  );
}

function PlaceholderGrid() {
  return (
    <div className="placeholder-grid">
      <div className="placeholder-panel">
        <h3>输入</h3>
        <div className="placeholder-line" />
        <div className="placeholder-line placeholder-line--short" />
      </div>
      <div className="placeholder-panel">
        <h3>运行状态</h3>
        <div className="placeholder-line" />
        <div className="placeholder-line placeholder-line--short" />
      </div>
      <div className="placeholder-panel">
        <h3>产物</h3>
        <div className="placeholder-line" />
        <div className="placeholder-line placeholder-line--short" />
      </div>
    </div>
  );
}

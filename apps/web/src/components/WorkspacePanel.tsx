import { FolderOpen } from 'lucide-react';
import type { SelectedWorkspaceFile } from '../app-types.js';
import type { EventVisibility, PublicProfile, WorkspaceIdentity } from '../api/types.js';
import type { WorkflowMode } from '../chat/chat-types.js';
import { isSafeWorkspaceSegment } from './workspace-validation.js';

interface WorkspacePanelProps {
  artifactRuleIds: string[];
  eventVisibility: EventVisibility;
  files: SelectedWorkspaceFile[];
  model: string;
  profileId: string;
  profiles: PublicProfile[];
  skillId: string;
  workflowMode: WorkflowMode;
  workspaceId: string | null;
  workspaceIdentity: WorkspaceIdentity;
  onAddFiles: (files: FileList) => void;
  onArtifactRuleIdsChange: (ids: string[]) => void;
  onEventVisibilityChange: (visibility: EventVisibility) => void;
  onFileTargetPathChange: (fileId: string, targetPath: string) => void;
  onModelChange: (model: string) => void;
  onProfileIdChange: (profileId: string) => void;
  onRemoveFile: (fileId: string) => void;
  onSkillIdChange: (skillId: string) => void;
  onWorkspaceIdentityChange: (identity: WorkspaceIdentity) => void;
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const selectedProfile = props.profiles.find((profile) => profile.id === props.profileId) ?? props.profiles[0] ?? null;
  const identityValid = Object.values(props.workspaceIdentity).every(isSafeWorkspaceSegment);
  const reviseMode = props.workflowMode === 'revise';

  return (
    <section className="setup-section">
      <div className="section-title">
        <FolderOpen size={16} aria-hidden="true" />
        <h2>Workspace</h2>
      </div>
      <label>
        Profile
        <select value={props.profileId} onChange={(event) => props.onProfileIdChange(event.target.value)}>
          {props.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <select value={props.model} onChange={(event) => props.onModelChange(event.target.value)}>
          {(selectedProfile?.allowedModels.length ? selectedProfile.allowedModels : [props.model]).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Skill
        <select disabled={reviseMode} value={props.skillId} onChange={(event) => props.onSkillIdChange(event.target.value)}>
          <option value="">No skill</option>
          {(selectedProfile?.allowedSkillIds ?? []).map((skillId) => (
            <option key={skillId} value={skillId}>
              {skillId}
            </option>
          ))}
        </select>
      </label>
      <label>
        Event Visibility
        <select
          value={props.eventVisibility}
          onChange={(event) => props.onEventVisibilityChange(event.target.value as EventVisibility)}
        >
          <option value="quiet">quiet</option>
          <option value="normal">normal</option>
          <option value="debug">debug</option>
        </select>
      </label>
      <fieldset className={identityValid ? '' : 'invalid'}>
        <legend>Workspace identity</legend>
        <IdentityInput field="originId" identity={props.workspaceIdentity} onChange={props.onWorkspaceIdentityChange} />
        <IdentityInput field="userId" identity={props.workspaceIdentity} onChange={props.onWorkspaceIdentityChange} />
        <IdentityInput field="projectId" identity={props.workspaceIdentity} onChange={props.onWorkspaceIdentityChange} />
        {!identityValid ? <p className="setup-hint is-error">Identity segments cannot contain path separators, dot segments, or null bytes.</p> : null}
      </fieldset>
      <div className="artifact-rule-list">
        {(selectedProfile?.artifactRules ?? []).map((rule) => (
          <label className="checkbox-row" key={rule.id}>
            <input
              checked={props.artifactRuleIds.includes(rule.id)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...props.artifactRuleIds, rule.id]
                  : props.artifactRuleIds.filter((id) => id !== rule.id);
                props.onArtifactRuleIdsChange(next);
              }}
              type="checkbox"
            />
            {rule.id}
          </label>
        ))}
      </div>
      <label className="file-picker">
        Input files
        <input multiple onChange={(event) => event.target.files && props.onAddFiles(event.target.files)} type="file" />
      </label>
      {props.files.length > 0 ? (
        <div className="file-list">
          {props.files.map((file) => (
            <div className="file-row" key={file.id}>
              <span>{file.file.name}</span>
              <input
                aria-label={`Target path for ${file.file.name}`}
                value={file.targetPath}
                onChange={(event) => props.onFileTargetPathChange(file.id, event.target.value)}
              />
              <button type="button" onClick={() => props.onRemoveFile(file.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <p className="setup-hint">Workspace: {props.workspaceId ?? 'created on first send'}</p>
    </section>
  );
}

function IdentityInput({
  field,
  identity,
  onChange,
}: {
  field: keyof WorkspaceIdentity;
  identity: WorkspaceIdentity;
  onChange: (identity: WorkspaceIdentity) => void;
}) {
  return (
    <label>
      {field}
      <input value={identity[field]} onChange={(event) => onChange({ ...identity, [field]: event.target.value })} />
    </label>
  );
}

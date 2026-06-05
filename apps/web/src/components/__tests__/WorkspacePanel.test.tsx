import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePanel } from '../WorkspacePanel.js';
import { isSafeWorkspaceSegment } from '../workspace-validation.js';
import type { PublicProfile } from '../../api/types.js';

const profile: PublicProfile = {
  id: 'report-docx',
  allowedSkillIds: ['report-gen'],
  artifactRules: [{ id: 'report-docx', role: 'primary', pattern: 'output/*.docx' }],
  defaultArtifactRuleIds: ['report-docx'],
  defaultModel: 'opus',
  allowedModels: ['opus', 'sonnet'],
  eventVisibility: 'normal',
  maxCollectionMode: 'lite',
  permissionMode: 'bypassPermissions',
  profileConcurrency: 1,
  runTimeoutMs: null,
  inactivityTimeoutMs: null,
  cancelGraceMs: 5000,
};

describe('WorkspacePanel', () => {
  it('validates safe workspace identity segments', () => {
    expect(isSafeWorkspaceSegment('project_001')).toBe(true);
    expect(isSafeWorkspaceSegment('.')).toBe(false);
    expect(isSafeWorkspaceSegment('..')).toBe(false);
    expect(isSafeWorkspaceSegment('bad/path')).toBe(false);
    expect(isSafeWorkspaceSegment('bad\\path')).toBe(false);
    expect(isSafeWorkspaceSegment('bad\0path')).toBe(false);
  });

  it('disables skill selection while revise mode is active', async () => {
    const user = userEvent.setup();
    const onProfileIdChange = vi.fn();

    render(
      <WorkspacePanel
        artifactRuleIds={['report-docx']}
        eventVisibility="normal"
        files={[]}
        model="opus"
        onAddFiles={() => undefined}
        onArtifactRuleIdsChange={() => undefined}
        onEventVisibilityChange={() => undefined}
        onFileTargetPathChange={() => undefined}
        onModelChange={() => undefined}
        onProfileIdChange={onProfileIdChange}
        onRemoveFile={() => undefined}
        onSkillIdChange={() => undefined}
        onWorkspaceIdentityChange={() => undefined}
        profileId="report-docx"
        profiles={[profile]}
        skillId="report-gen"
        workflowMode="revise"
        workspaceId={null}
        workspaceIdentity={{ originId: 'demo', userId: 'user_001', projectId: 'project_001' }}
      />,
    );

    expect(screen.getByLabelText('Skill')).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Profile'), 'report-docx');

    expect(onProfileIdChange).toHaveBeenCalledWith('report-docx');
  });
});

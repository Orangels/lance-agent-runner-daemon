import { useState } from 'react';
import { AppShell, type RpaSectionId } from './components/AppShell.js';
import './styles.css';

export function App() {
  const [activeSectionId, setActiveSectionId] = useState<RpaSectionId>('codegen');
  return <AppShell activeSectionId={activeSectionId} onSectionChange={setActiveSectionId} />;
}

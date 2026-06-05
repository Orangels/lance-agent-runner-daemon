export interface RpaHealthResponse {
  ok: true;
  app: 'rpa-local-web';
}

export interface RpaConfigResponse {
  defaultProfileId: string;
  daemonConfigured: boolean;
}

export interface RpaDaemonHealthResponse {
  ok: boolean;
  daemonReachable: boolean;
  status?: number;
  error?: string;
}

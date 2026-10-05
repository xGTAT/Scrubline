export interface HostInfo {
  vscodeVersion: string;
  appName: string;
  appHost: string;
  language: string;
  workspaceFolders: string[];
  extensionPath: string;
}

export interface RequestHostInfoMessage {
  type: 'request-host-info';
}

export interface HostInfoMessage {
  type: 'host-info';
  data: HostInfo;
}

export type WebviewInboundMessage = RequestHostInfoMessage;
export type WebviewOutboundMessage = HostInfoMessage;

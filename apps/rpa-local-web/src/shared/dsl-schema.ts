export const RPA_DSL_VERSION = 'rpa-dsl.v0.1' as const;

export const rpaDslParamTypeValues = ['string', 'number', 'date', 'boolean', 'select', 'secret'] as const;
export type RpaDslParamType = (typeof rpaDslParamTypeValues)[number];

export const rpaDslActionValues = [
  'navigate',
  'click',
  'input',
  'select',
  'submit',
  'assert',
  'wait',
  'manual',
] as const;
export type RpaDslAction = (typeof rpaDslActionValues)[number];

export const rpaDslTargetByValues = [
  'role',
  'label',
  'placeholder',
  'text',
  'testid',
  'id',
  'css',
  'xpath',
] as const;
export type RpaDslTargetBy = (typeof rpaDslTargetByValues)[number];

export const rpaDslAssertTypeValues = [
  'visible',
  'hidden',
  'text_contains',
  'url_contains',
  'download_exists',
  'row_count_gt',
] as const;
export type RpaDslAssertType = (typeof rpaDslAssertTypeValues)[number];

export interface RpaDslParamOption {
  label: string;
  value: string;
}

export interface RpaDslParamDefinition {
  type: RpaDslParamType;
  label?: string;
  description?: string;
  required?: boolean;
  mask?: boolean;
  default?: string | number | boolean;
  options?: RpaDslParamOption[];
}

export interface RpaDslMeta {
  title: string;
  source: 'codegen' | 'nl' | 'imported';
  created_at?: string;
  updated_at?: string;
}

export interface RpaDslContext {
  base_url?: string;
  storage_state?: string;
  default_timeout_ms?: number;
  [key: string]: unknown;
}

export interface RpaDslTarget {
  by: RpaDslTargetBy;
  frame?: string[];
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testid?: string;
  id?: string;
  css?: string;
  xpath?: string;
  scope?: string;
  filter?: { has_text?: string };
}

export interface RpaDslWaitCondition {
  visible?: boolean;
  enabled?: boolean;
  url_changes?: boolean;
  url_contains?: string;
  network_idle?: boolean;
  download?: boolean;
  toast?: boolean;
  table_loaded?: boolean;
}

export interface RpaDslWait {
  before?: RpaDslWaitCondition;
  after?: RpaDslWaitCondition;
}

export interface RpaDslAssertion {
  type: RpaDslAssertType;
  target?: RpaDslTarget;
  text?: string;
  value?: string;
}

export interface RpaDslManual {
  type: 'captcha' | 'login' | 'ca_usbkey' | 'confirm' | 'other';
  instruction: string;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface RpaDslStep {
  id: string;
  name: string;
  action: RpaDslAction;
  target?: RpaDslTarget;
  value?: string | number | boolean;
  wait?: RpaDslWait;
  assert?: RpaDslAssertion[];
  write: boolean;
  idempotency_key?: string;
  manual: RpaDslManual | null;
}

export interface RpaDslDocument {
  dsl_version: typeof RPA_DSL_VERSION;
  flow_id: string;
  meta: RpaDslMeta;
  params: Record<string, RpaDslParamDefinition>;
  context: RpaDslContext;
  steps: RpaDslStep[];
}

export function isRpaAction(value: string): value is RpaDslAction {
  return (rpaDslActionValues as readonly string[]).includes(value);
}

export function createMinimalRpaDsl(): RpaDslDocument {
  return {
    dsl_version: RPA_DSL_VERSION,
    flow_id: 'case_query',
    meta: {
      title: '案件查询',
      source: 'codegen',
      created_at: '2026-06-06T00:00:00+08:00',
    },
    params: {
      case_no: {
        type: 'string',
        label: '案件编号',
        required: true,
        mask: true,
      },
    },
    context: {
      base_url: '${BASE_URL}',
      default_timeout_ms: 15000,
    },
    steps: [
      {
        id: 's1',
        name: '打开查询页',
        action: 'navigate',
        value: '${base_url}',
        wait: { after: { network_idle: true } },
        assert: [{ type: 'url_contains', value: '/query' }],
        write: false,
        manual: null,
      },
    ],
  };
}

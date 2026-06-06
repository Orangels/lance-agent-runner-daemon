import {
  RPA_DSL_VERSION,
  rpaDslActionValues,
  rpaDslAssertTypeValues,
  rpaDslParamTypeValues,
  rpaDslTargetByValues,
} from './dsl-schema.js';

export const rpaDslJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lance-agent-runner.local/schemas/rpa-dsl.v0.1.json',
  title: 'RPA DSL v0.1',
  type: 'object',
  additionalProperties: false,
  required: ['dsl_version', 'flow_id', 'meta', 'params', 'context', 'steps'],
  properties: {
    dsl_version: { const: RPA_DSL_VERSION },
    flow_id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
    meta: {
      type: 'object',
      required: ['title', 'source'],
      additionalProperties: true,
      properties: {
        title: { type: 'string', minLength: 1 },
        source: { enum: ['codegen', 'nl', 'imported'] },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
      },
    },
    params: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['type'],
        additionalProperties: true,
        properties: {
          type: { enum: [...rpaDslParamTypeValues] },
          label: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean' },
          mask: { type: 'boolean' },
          default: { type: ['string', 'number', 'boolean'] },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'value'],
              additionalProperties: false,
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
      },
    },
    context: { type: 'object', additionalProperties: true },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'name', 'action', 'write', 'manual'],
        additionalProperties: true,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
          name: { type: 'string', minLength: 1 },
          action: { enum: [...rpaDslActionValues] },
          target: {
            type: 'object',
            required: ['by'],
            additionalProperties: true,
            properties: {
              by: { enum: [...rpaDslTargetByValues] },
              frame: { type: 'array', items: { type: 'string' } },
              role: { type: 'string' },
              name: { type: 'string' },
              label: { type: 'string' },
              placeholder: { type: 'string' },
              text: { type: 'string' },
              testid: { type: 'string' },
              id: { type: 'string' },
              css: { type: 'string' },
              xpath: { type: 'string' },
              scope: { type: 'string' },
            },
          },
          value: { type: ['string', 'number', 'boolean'] },
          wait: { type: 'object', additionalProperties: true },
          assert: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              additionalProperties: true,
              properties: {
                type: { enum: [...rpaDslAssertTypeValues] },
              },
            },
          },
          write: { type: 'boolean' },
          idempotency_key: { type: 'string' },
          manual: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['type', 'instruction'],
                additionalProperties: true,
                properties: {
                  type: { enum: ['captcha', 'login', 'ca_usbkey', 'confirm', 'other'] },
                  instruction: { type: 'string' },
                  riskLevel: { enum: ['low', 'medium', 'high'] },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;

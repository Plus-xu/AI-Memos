/* exported LLM_CONFIG */
/**
 * LLM 模型配置
 * 用于管理不同提供商的模型列表
 */

const LLM_CONFIG = {
  // Text generation catalog verified 2026-11-19. Account-specific entries are loaded on request.
  providers: {
    openai: {
      name: 'OpenAI',
      endpointType: 'openai-responses',
      apiUrl: 'https://api.openai.com/v1/responses',
      modelsUrl: 'https://api.openai.com/v1/models',
      models: [
        {
          value: 'gpt-6.2-sol',
          label: 'GPT-6.2 Sol'
        },
        {
          value: 'gpt-6.2-astra',
          label: 'GPT-6.2 Astra'
        },
        {
          value: 'gpt-6.1-terra',
          label: 'GPT-6.1 Terra'
        },
        {
          value: 'gpt-6-luna',
          label: 'GPT-6 Luna'
        },
        {
          value: 'custom',
          label: 'Custom'
        }
      ]
    },
    deepseek: {
      name: 'DeepSeek',
      endpointType: 'chat-completions',
      apiUrl: 'https://api.deepseek.com/v1/chat/completions',
      modelsUrl: 'https://api.deepseek.com/models',
      models: [
        {
          value: 'deepseek-flash',
          label: 'DeepSeek V4.1 Flash'
        },
        {
          value: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro'
        },
        {
          value: 'custom',
          label: 'Custom'
        }
      ]
    },
    gemini: {
      name: 'Gemini',
      endpointType: 'gemini',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
      modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      models: [
        {
          value: 'gemini-4-hydrogen',
          label: 'Gemini 4 Hydrogen'
        },
        {
          value: 'gemini-4-neon',
          label: 'Gemini 4 Neon'
        },
        {
          value: 'gemini-4-argon',
          label: 'Gemini 4 Argon'
        },
        {
          value: 'gemini-4-carbon',
          label: 'Gemini 4 Carbon'
        },
        {
          value: 'gemini-3.5-flash-lite',
          label: 'Gemini 3.5 Flash-Lite'
        },
        {
          value: 'custom',
          label: 'Custom'
        }
      ]
    },
    anthropic: {
      name: 'Anthropic',
      endpointType: 'anthropic',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      modelsUrl: 'https://api.anthropic.com/v1/models',
      anthropicVersion: '2023-06-01',
      models: [
        {
          value: 'claude-sonnet-5-5',
          label: 'Claude Sonnet 5.5'
        },
        {
          value: 'claude-haiku-5-5',
          label: 'Claude Haiku 5.5'
        },
        {
          value: 'claude-opus-5-5',
          label: 'Claude Opus 5.5'
        },
        {
          value: 'claude-fable-5-2',
          label: 'Claude Fable 5.2'
        },
        {
          value: 'custom',
          label: 'Custom'
        }
      ]
    },
    newapi: {
      name: 'New API',
      endpointType: 'chat-completions',
      requiresBaseUrl: true,
      models: [
        {
          value: 'custom',
          label: 'Custom'
        }
      ]
    }
  },

  // 默认配置
  defaults: {
    provider: 'openai',
    model: 'gpt-6.2-sol',
    maxTokens: 8192
  }
};

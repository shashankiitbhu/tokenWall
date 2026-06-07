export interface Message {
  role: string;
  content: string;
}

export interface NormalizedRequest {
  provider: 'openai' | 'anthropic' | 'gemini';
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
  toolsAttached: boolean;
  rawBody: any;
}

export interface NormalizedResponse {
  id: string;
  model: string;
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class ProviderRegistry {
  static parseRequest(provider: 'openai' | 'anthropic' | 'gemini', body: any, urlPath?: string): NormalizedRequest {
    if (provider === 'openai') {
      const messages = (body.messages || []).map((m: any) => ({
        role: m.role || 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      }));
      return {
        provider: 'openai',
        model: body.model || 'unknown',
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        stream: !!body.stream,
        toolsAttached: !!(body.tools && body.tools.length > 0),
        rawBody: body
      };
    }

    if (provider === 'anthropic') {
      const messages = (body.messages || []).map((m: any) => ({
        role: m.role || 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      }));
      return {
        provider: 'anthropic',
        model: body.model || 'unknown',
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        stream: !!body.stream,
        toolsAttached: !!(body.tools && body.tools.length > 0),
        rawBody: body
      };
    }

    if (provider === 'gemini') {
      // Gemini formats contents as [{ role: 'user', parts: [{ text: '...' }] }]
      // Extract model from URL path if possible, or body
      let model = 'gemini-1.5-flash';
      if (urlPath) {
        const match = urlPath.match(/\/models\/([^:/]+)/);
        if (match) model = match[1];
      }
      const contents = body.contents || [];
      const messages: Message[] = [];
      for (const content of contents) {
        const role = content.role === 'model' ? 'assistant' : 'user';
        const partsText = (content.parts || [])
          .map((p: any) => p.text || '')
          .join('\n');
        messages.push({ role, content: partsText });
      }

      const config = body.generationConfig || {};
      return {
        provider: 'gemini',
        model,
        messages,
        temperature: config.temperature,
        maxTokens: config.maxOutputTokens,
        stream: urlPath ? urlPath.includes('stream') : false,
        toolsAttached: !!(body.tools && body.tools.length > 0),
        rawBody: body
      };
    }

    throw new Error(`Unsupported provider: ${provider}`);
  }

  static parseResponse(provider: 'openai' | 'anthropic' | 'gemini', body: any): NormalizedResponse {
    if (provider === 'openai') {
      const content = body.choices?.[0]?.message?.content || '';
      return {
        id: body.id || '',
        model: body.model || '',
        content,
        usage: {
          inputTokens: body.usage?.prompt_tokens || 0,
          outputTokens: body.usage?.completion_tokens || 0
        }
      };
    }

    if (provider === 'anthropic') {
      const content = (body.content || [])
        .map((c: any) => c.text || '')
        .join('\n');
      return {
        id: body.id || '',
        model: body.model || '',
        content,
        usage: {
          inputTokens: body.usage?.input_tokens || 0,
          outputTokens: body.usage?.output_tokens || 0
        }
      };
    }

    if (provider === 'gemini') {
      const candidate = body.candidates?.[0];
      const content = (candidate?.content?.parts || [])
        .map((p: any) => p.text || '')
        .join('\n');
      return {
        id: '',
        model: '',
        content,
        usage: {
          inputTokens: body.usageMetadata?.promptTokenCount || 0,
          outputTokens: body.usageMetadata?.candidatesTokenCount || 0
        }
      };
    }

    throw new Error(`Unsupported provider: ${provider}`);
  }

  static parseStreamChunk(provider: 'openai' | 'anthropic' | 'gemini', chunkText: string): { text: string; usage?: { inputTokens: number; outputTokens: number } } | null {
    try {
      if (provider === 'openai') {
        const jsonStr = chunkText.trim();
        if (jsonStr === '[DONE]') return null;
        const parsed = JSON.parse(jsonStr);
        const text = parsed.choices?.[0]?.delta?.content || '';
        const usage = parsed.usage ? {
          inputTokens: parsed.usage.prompt_tokens || 0,
          outputTokens: parsed.usage.completion_tokens || 0
        } : undefined;
        return { text, usage };
      }

      if (provider === 'anthropic') {
        const jsonStr = chunkText.trim();
        const parsed = JSON.parse(jsonStr);
        
        let text = '';
        let usage: any;

        if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') {
            text = parsed.delta?.text || '';
          } else if (parsed.delta?.type === 'input_json_delta') {
            text = parsed.delta?.partial_json || '';
          }
        } else if (parsed.type === 'message_start') {
          usage = {
            inputTokens: parsed.message?.usage?.input_tokens || 0,
            outputTokens: parsed.message?.usage?.output_tokens || 0
          };
        } else if (parsed.type === 'message_delta') {
          usage = {
            inputTokens: parsed.usage?.input_tokens || 0,
            outputTokens: parsed.usage?.output_tokens || 0
          };
        } else if (parsed.type === 'content_block_start') {
          if (parsed.content_block?.type === 'tool_use') {
            text = `[Tool Use: ${parsed.content_block.name}]`;
          }
        }
        return { text, usage };
      }

      if (provider === 'gemini') {
        const parsed = JSON.parse(chunkText);
        const candidate = parsed.candidates?.[0];
        const text = (candidate?.content?.parts || [])
          .map((p: any) => p.text || '')
          .join('\n');
        const usage = parsed.usageMetadata ? {
          inputTokens: parsed.usageMetadata.promptTokenCount || 0,
          outputTokens: parsed.usageMetadata.candidatesTokenCount || 0
        } : undefined;
        return { text, usage };
      }
    } catch {
      // Chunk segment could be partial
    }
    return null;
  }
}

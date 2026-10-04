import {
  type CacheHint,
  type CallToolResult,
  type GetPromptResult,
  type Icon,
  type InputRequiredResult,
  type McpServer,
  type PromptCallback,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  type ResourceMetadata,
  type ResourceTemplate,
  type ScopeChallengeHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
  UrlElicitationRequiredError,
  type Variables,
} from '@modelcontextprotocol/server';
import type { Deps } from '../server';

/**
 * `defineTool`, `defineResource` and `definePrompt` take exactly the arguments of
 * `server.registerTool`, `registerResource` and `registerPrompt`, and add two things:
 *
 *  1. `deps` as the handler's last argument, so primitives use services without globals.
 *  2. One error policy. Expected failures are explicit: return `toolError(...)` from a tool,
 *     throw `ProtocolError` or `ResourceNotFoundError` from a resource or prompt. Anything
 *     else thrown is a bug: it is logged with a reference, and the client gets only the
 *     reference, never the message, which may carry upstream URLs or data.
 */
export interface Definition {
  readonly name: string;
  register(server: McpServer, deps: Deps): void;
}

type MaybePromise<T> = T | Promise<T>;
type ToolResult = CallToolResult | InputRequiredResult;

export interface ToolConfig<Input, Output> {
  title?: string;
  /** Required: the model chooses tools by their description. */
  description: string;
  inputSchema?: Input;
  outputSchema?: Output;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  scopeChallenge?: ScopeChallengeHandler;
  _meta?: Record<string, unknown>;
}

export type ToolHandler<Input extends StandardSchemaWithJSON | undefined> =
  Input extends StandardSchemaWithJSON
    ? (
        args: StandardSchemaWithJSON.InferOutput<Input>,
        ctx: ServerContext,
        deps: Deps,
      ) => MaybePromise<ToolResult>
    : (ctx: ServerContext, deps: Deps) => MaybePromise<ToolResult>;

export function defineTool<
  Output extends StandardSchemaWithJSON,
  Input extends StandardSchemaWithJSON | undefined = undefined,
>(name: string, config: ToolConfig<Input, Output>, handler: ToolHandler<Input>): Definition {
  return {
    name,
    register(server, deps) {
      const callback = withErrorPolicy(handler, deps, (error, ctx) => {
        const reference = logUnexpected(deps, 'tool', name, ctx, error);
        return toolError(
          `The ${name} tool failed because of an internal error (reference ${reference}). ` +
            'Retrying will not help; tell the user.',
        );
      });
      server.registerTool<Output, Input>(name, config, callback as ToolCallback<Input>);
    },
  };
}

/** A failure the model should read and recover from. Put the fix in the message. */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Send a progress update, if the client asked for progress on this request. */
export async function reportProgress(
  ctx: ServerContext,
  progress: number,
  total: number,
  message?: string,
): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return;
  await ctx.mcpReq.notify({
    method: 'notifications/progress',
    params: { progressToken, progress, total, ...(message && { message }) },
  });
}

type ResourceConfig = ResourceMetadata & {
  cacheHint?: CacheHint;
  scopeChallenge?: ScopeChallengeHandler;
};
type ResourceResult = MaybePromise<ReadResourceResult | InputRequiredResult>;

export function defineResource(
  name: string,
  uri: string,
  config: ResourceConfig,
  read: (uri: URL, ctx: ServerContext, deps: Deps) => ResourceResult,
): Definition;
export function defineResource(
  name: string,
  template: ResourceTemplate,
  config: ResourceConfig,
  read: (uri: URL, variables: Variables, ctx: ServerContext, deps: Deps) => ResourceResult,
): Definition;
export function defineResource(
  name: string,
  uriOrTemplate: string | ResourceTemplate,
  config: ResourceConfig,
  read: (...args: never[]) => ResourceResult,
): Definition {
  return {
    name,
    register(server, deps) {
      const callback = withErrorPolicy(read, deps, (error, ctx) => {
        throw internalError(logUnexpected(deps, 'resource', name, ctx, error));
      });
      if (typeof uriOrTemplate === 'string') {
        server.registerResource(name, uriOrTemplate, config, callback);
      } else {
        server.registerResource(name, uriOrTemplate, config, callback);
      }
    },
  };
}

export interface PromptConfig<Args> {
  title?: string;
  description: string;
  argsSchema?: Args;
  icons?: Icon[];
  scopeChallenge?: ScopeChallengeHandler;
  _meta?: Record<string, unknown>;
}

type PromptResult = MaybePromise<GetPromptResult | InputRequiredResult>;

export type PromptHandler<Args extends StandardSchemaWithJSON | undefined> =
  Args extends StandardSchemaWithJSON
    ? (
        args: StandardSchemaWithJSON.InferOutput<Args>,
        ctx: ServerContext,
        deps: Deps,
      ) => PromptResult
    : (ctx: ServerContext, deps: Deps) => PromptResult;

export function definePrompt<Args extends StandardSchemaWithJSON | undefined = undefined>(
  name: string,
  config: PromptConfig<Args>,
  handler: PromptHandler<Args>,
): Definition {
  return {
    name,
    register(server, deps) {
      const callback = withErrorPolicy(handler, deps, (error, ctx) => {
        throw internalError(logUnexpected(deps, 'prompt', name, ctx, error));
      });
      server.registerPrompt(
        name,
        config as PromptConfig<StandardSchemaWithJSON>,
        callback as PromptCallback<StandardSchemaWithJSON>,
      );
    },
  };
}

/**
 * Wrap a handler so it receives `deps` after the SDK's own arguments. Every SDK callback
 * passes the request context last: `(args, ctx)`, `(ctx)`, `(uri, ctx)` or `(uri, vars, ctx)`.
 */
function withErrorPolicy<Result>(
  handler: (...args: never[]) => MaybePromise<Result>,
  deps: Deps,
  onUnexpected: (error: unknown, ctx: ServerContext) => Result,
): (...args: unknown[]) => Promise<Result> {
  // Each define* function types its handler precisely; here it is called with what the SDK passed.
  const call = handler as (...args: unknown[]) => MaybePromise<Result>;
  return async (...args) => {
    const ctx = args.at(-1) as ServerContext;
    try {
      return await call(...args, deps);
    } catch (error) {
      if (isDeliberate(error) || ctx.mcpReq.signal.aborted) throw error;
      return onUnexpected(error, ctx);
    }
  };
}

/** Errors the SDK turns into the right response on its own. */
function isDeliberate(error: unknown): boolean {
  return ProtocolError.isInstance(error) || error instanceof UrlElicitationRequiredError;
}

function logUnexpected(
  deps: Deps,
  kind: 'tool' | 'resource' | 'prompt',
  name: string,
  ctx: ServerContext,
  error: unknown,
): string {
  const reference = crypto.randomUUID();
  deps.logger.error(`Unexpected ${kind} failure`, {
    [kind]: name,
    requestId: ctx.mcpReq.id,
    reference,
    error,
  });
  return reference;
}

function internalError(reference: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    `Internal error (reference ${reference})`,
  );
}

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
  ResourceTemplate,
  type ScopeChallengeHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
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
 *
 * The policy covers tool calls, resource reads, resource template `list` and `complete`
 * callbacks, and prompt gets. `completable()` attaches its completer as a property that
 * can't be replaced, so completers run outside it; keep them to filtering local values.
 */
export interface Definition {
  readonly name: string;
  register(server: McpServer, deps: Deps): void;
}

type MaybePromise<T> = T | Promise<T>;

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

/** An error result: text for the model, and no structured content. */
export type ToolErrorResult = CallToolResult & { isError: true; structuredContent?: never };

/**
 * What a tool may return. With an `outputSchema`, every successful result must carry
 * `structuredContent` matching it: the SDK validates the value you return, so it is typed
 * as the schema's input.
 */
export type ToolResult<Output extends StandardSchemaWithJSON | undefined> =
  | ToolErrorResult
  | InputRequiredResult
  | (Output extends StandardSchemaWithJSON
      ? CallToolResult & { structuredContent: StandardSchemaWithJSON.InferInput<Output> }
      : CallToolResult);

export type ToolHandler<
  Input extends StandardSchemaWithJSON | undefined,
  Output extends StandardSchemaWithJSON | undefined,
> = Input extends StandardSchemaWithJSON
  ? (
      args: StandardSchemaWithJSON.InferOutput<Input>,
      ctx: ServerContext,
      deps: Deps,
    ) => MaybePromise<ToolResult<Output>>
  : (ctx: ServerContext, deps: Deps) => MaybePromise<ToolResult<Output>>;

export function defineTool<
  Output extends StandardSchemaWithJSON | undefined = undefined,
  Input extends StandardSchemaWithJSON | undefined = undefined,
>(
  name: string,
  config: ToolConfig<Input, Output>,
  handler: ToolHandler<Input, Output>,
): Definition {
  return {
    name,
    register(server, deps) {
      const callback = withErrorPolicy(handler, deps, (error, ctx) => {
        const reference = logUnexpected(deps, 'tool', name, ctx, error);
        return toolError(
          `The ${name} tool failed with an internal error (reference ${reference}). ` +
            'Tell the user; the server logs have the details.',
        );
      });
      // The SDK's overload wants a schema type for the output even when there is none.
      server.registerTool<StandardSchemaWithJSON, Input>(
        name,
        config as ToolConfig<Input, StandardSchemaWithJSON>,
        callback as ToolCallback<Input>,
      );
    },
  };
}

/** A failure the model should read and recover from. Put the fix in the message. */
export function toolError(message: string): ToolErrorResult {
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
type TemplateRead = (
  uri: URL,
  variables: Variables,
  ctx: ServerContext,
  deps: Deps,
) => ResourceResult;

/** A static resource: one fixed URI. */
export function defineResource(
  name: string,
  uri: string,
  config: ResourceConfig,
  read: (uri: URL, ctx: ServerContext, deps: Deps) => ResourceResult,
): Definition;
/**
 * A resource template. Pass a function of `deps` when its `list` or `complete` callbacks
 * need services; it runs once per request, when the server is built.
 */
export function defineResource(
  name: string,
  template: ResourceTemplate | ((deps: Deps) => ResourceTemplate),
  config: ResourceConfig,
  read: TemplateRead,
): Definition;
export function defineResource(
  name: string,
  uriOrTemplate: string | ResourceTemplate | ((deps: Deps) => ResourceTemplate),
  config: ResourceConfig,
  read: (...args: never[]) => ResourceResult,
): Definition {
  return {
    name,
    register(server, deps) {
      const policy = protocolErrorPolicy(deps, 'resource', name);
      const callback = withErrorPolicy(read, deps, policy);
      if (typeof uriOrTemplate === 'string') {
        server.registerResource(name, uriOrTemplate, config, callback);
        return;
      }
      const template = typeof uriOrTemplate === 'function' ? uriOrTemplate(deps) : uriOrTemplate;
      server.registerResource(name, withSafeCallbacks(template, policy), config, callback);
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
      const callback = withErrorPolicy(handler, deps, protocolErrorPolicy(deps, 'prompt', name));
      server.registerPrompt(
        name,
        config as PromptConfig<StandardSchemaWithJSON>,
        callback as PromptCallback<StandardSchemaWithJSON>,
      );
    },
  };
}

type Policy<Result> = (error: unknown, ctx: ServerContext | undefined) => Result;

/**
 * Wrap a handler so it receives `deps` after the SDK's own arguments. Every SDK callback
 * passes the request context last: `(args, ctx)`, `(ctx)`, `(uri, ctx)` or `(uri, vars, ctx)`.
 */
function withErrorPolicy<Result>(
  handler: (...args: never[]) => MaybePromise<Result>,
  deps: Deps,
  onUnexpected: Policy<Result>,
): (...args: unknown[]) => Promise<Result> {
  // Each define* function types its handler precisely; here it is called with what the SDK passed.
  const call = handler as (...args: unknown[]) => MaybePromise<Result>;
  return async (...args) => {
    const ctx = args.at(-1) as ServerContext;
    try {
      return await call(...args, deps);
    } catch (error) {
      // Deliberate protocol errors and cancellations are the SDK's to answer.
      if (ProtocolError.isInstance(error) || ctx.mcpReq.signal.aborted) throw error;
      return onUnexpected(error, ctx);
    }
  };
}

/** Resource and prompt failures reach the client as a JSON-RPC error carrying a reference. */
function protocolErrorPolicy(deps: Deps, kind: Kind, name: string): Policy<never> {
  return (error, ctx) => {
    const reference = logUnexpected(deps, kind, name, ctx, error);
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Internal error (reference ${reference})`,
    );
  };
}

/** The same template, with its `list` and `complete` callbacks under the error policy. */
function withSafeCallbacks(template: ResourceTemplate, policy: Policy<never>): ResourceTemplate {
  const guard =
    <Args extends unknown[], Result>(callback: (...args: Args) => MaybePromise<Result>) =>
    async (...args: Args): Promise<Result> => {
      try {
        return await callback(...args);
      } catch (error) {
        if (ProtocolError.isInstance(error)) throw error;
        return policy(error, undefined);
      }
    };

  const list = template.listCallback;
  const complete = Object.fromEntries(
    template.uriTemplate.variableNames.flatMap((variable) => {
      const callback = template.completeCallback(variable);
      return callback ? [[variable, guard(callback)]] : [];
    }),
  );
  return new ResourceTemplate(template.uriTemplate, {
    list: list && guard(list),
    complete,
  });
}

type Kind = 'tool' | 'resource' | 'prompt';

/** Log an unexpected failure at error level and return the reference to show the client. */
function logUnexpected(
  deps: Deps,
  kind: Kind,
  name: string,
  ctx: ServerContext | undefined,
  error: unknown,
): string {
  const reference = crypto.randomUUID();
  deps.logger.error(`Unexpected ${kind} failure`, {
    [kind]: name,
    reference,
    ...(ctx && { requestId: ctx.mcpReq.id }),
    error,
  });
  return reference;
}

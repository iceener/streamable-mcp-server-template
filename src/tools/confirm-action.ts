import {
  acceptedContent,
  inputRequired,
  inputResponse,
  requireScopes,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { defineTool, toolError } from '../platform/primitives';

const Approval = z.object({
  approve: z.boolean().meta({ title: 'Approve this action' }),
});

/**
 * Asks the user before acting, with `input_required` (protocol 2026-07-28): the handler
 * returns the question, the client answers and calls again, and the handler runs with the
 * answer. Nothing is held on the server between the two calls.
 *
 * A client that doesn't support form elicitation can't be asked, so nothing runs: a
 * 2026-07-28 client gets error -32021 naming the missing capability, and a 2025-era client
 * (served without a session) gets a tool error saying it can't receive the question.
 *
 * It also needs its own OAuth scope. Without `actions:write` the SDK answers
 * `403 insufficient_scope` before the handler runs, so the client can ask for more access.
 *
 * Pattern sample: it performs no real side effect. Put yours after the approval check.
 */
export const confirmAction = defineTool(
  'confirm-action',
  {
    title: 'Confirm an action',
    description:
      'Ask the user to approve an action before it runs. Fails if the user does not approve.',
    inputSchema: z.object({
      action: z.string().min(1).max(200).describe('What will happen, in one sentence'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    scopeChallenge: requireScopes('actions:write'),
  },
  ({ action }, ctx) => {
    const answers = ctx.mcpReq.inputResponses;
    if (inputResponse(answers, 'approval').kind === 'missing') {
      return inputRequired({
        inputRequests: {
          approval: inputRequired.elicit({
            message: `Approve: ${action}?`,
            requestedSchema: Approval,
          }),
        },
      });
    }

    if (acceptedContent(answers, 'approval', Approval)?.approve !== true) {
      return toolError('The user did not approve this action. Do not retry unless they ask.');
    }
    return { content: [{ type: 'text', text: `Approved: ${action}` }] };
  },
);

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpBackendError, type McpDispatch } from './backend.js';
import { financeNoticeSchema } from './finance-schemas.js';

const account = z.string().min(1).max(128);
const page = { cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional() };
const date = z.iso.date();

/** Registration is opt-in. The database independently checks every grant and account. */
export function registerFinanceTools(server: McpServer, dispatch: McpDispatch, options: { readOnly?: boolean } = {}) {
  function tool(name: string, action: string, description: string, schema: z.ZodType<Record<string, unknown>>, write = false) {
    if (write && options.readOnly) return;
    server.registerTool(
      `tr8_${name}`,
      {
        description,
        inputSchema: schema,
        annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async input => {
        try {
          const data = await dispatch(action, input);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
        } catch (cause) {
          const error = cause instanceof McpBackendError ? cause : new McpBackendError('UNAVAILABLE');
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: error.code, message: error.message }) }] };
        }
      },
    );
  }
  tool(
    'get_finance_context',
    'finance_context',
    'Consulta permisos financieros explícitos, cuentas, buzones, categorías autorizadas y versión del registro. La bóveda cifrada queda excluida.',
    z.object({}).strict(),
  );
  tool(
    'list_finance_accounts',
    'finance_list_accounts',
    'Lista únicamente cuentas autorizadas, sus monedas y fecha de inicio de avisos. Sigue next_cursor hasta null.',
    z.object(page).strict(),
  );
  tool(
    'list_finance_categories',
    'finance_list_categories',
    'Consulta categorías autorizadas para ingresos y compras. No crea categorías ni concede permisos.',
    z.object({}).strict(),
  );
  tool(
    'list_finance_movements',
    'finance_list_movements',
    'Consulta movimientos para conciliación en cuentas autorizadas. date_to exclusivo, máximo 93 días. Incluye importes exactos y no expone notas privadas ni cuerpos de correo.',
    z
      .object({
        ...page,
        date_from: date,
        date_to: date,
        account_id: account.optional(),
        kind: z.enum(['income', 'expense', 'transfer', 'card-payment', 'refund']).optional(),
      })
      .strict(),
  );
  tool(
    'submit_finance_notice',
    'finance_submit_notice',
    'Registra un ingreso o compra confirmados si cumplen el permiso y la fecha inicial de la cuenta; los demás avisos quedan en revisión sin alterar saldos. ' +
      'Importe decimal como texto sin separadores de miles ni conversiones. Los IDs de buzón y origen son opacos, nunca números bancarios. ' +
      'request_id y payload estables para reintentos; una referencia bancaria identifica la operación y message_id el correo. No inventes una referencia para habilitar el registro. ' +
      'expected_version se obtiene del contexto; ante PT409 consulta de nuevo antes de reenviar. Solo registro contable, nunca operaciones bancarias reales.',
    financeNoticeSchema,
    true,
  );
  tool(
    'list_finance_reviews',
    'finance_list_reviews',
    'Consulta avisos pendientes de revisión en cuentas autorizadas. No los aprueba ni modifica saldos.',
    z.object(page).strict(),
  );
}

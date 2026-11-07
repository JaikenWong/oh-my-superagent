/** A refusal a person or an agent can cause; the API answers it with 400 (404 for `missing`). */
export class UserError extends Error {
  readonly code: string
  readonly values: Record<string, string>
  constructor(code: string, values: Record<string, string> = {}) {
    super(`${code}${Object.keys(values).length ? ` ${JSON.stringify(values)}` : ''}`)
    this.code = code
    this.values = values
  }
}

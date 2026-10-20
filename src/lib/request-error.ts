// Messages from this class are app-defined and safe to display to the browser.
export class RequestError extends Error {
  constructor(message: string, public code: string, public status = 400) { super(message); }
}

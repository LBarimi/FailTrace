import { StringDecoder } from 'node:string_decoder';

/** Match decoded UTF-8 without retaining the output; a needle may cross any chunk boundary. */
export class SubstringMatcher {
  private readonly decoder = new StringDecoder('utf8');
  private tail = '';
  matched = false;

  constructor(private readonly needle: string) {}

  private consume(text: string): void {
    if (this.matched) return;
    const combined = this.tail + text;
    this.matched = combined.includes(this.needle);
    this.tail = this.matched || this.needle.length <= 1 ? '' : combined.slice(-(this.needle.length - 1));
  }

  write(bytes: Buffer): void {
    if (!this.matched) this.consume(this.decoder.write(bytes));
  }

  end(): void {
    if (!this.matched) this.consume(this.decoder.end());
  }
}

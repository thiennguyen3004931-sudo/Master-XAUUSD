export interface Detector<TInput, TResult> {
  readonly name: string;
  detect(input: TInput): TResult | Promise<TResult>;
}

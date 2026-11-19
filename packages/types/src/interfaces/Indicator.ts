export interface Indicator<TInput, TResult> {
  readonly name: string;
  calculate(input: TInput): TResult;
}

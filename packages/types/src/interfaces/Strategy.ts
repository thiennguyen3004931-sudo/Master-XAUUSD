export interface Strategy<TContext, TResult> {
  readonly name: string;
  execute(context: TContext): TResult | Promise<TResult>;
}

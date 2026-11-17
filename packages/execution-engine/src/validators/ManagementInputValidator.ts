import type { PositionManagementContext } from "../models";

export class ManagementInputValidator {
  validate(context: PositionManagementContext): void {
    if (!context.plan || !context.position || !context.quote) {
      throw new TypeError(
        "Management context requires plan, position and quote.",
      );
    }

    if (context.plan.order.symbol !== context.position.symbol) {
      throw new Error(
        "Strategy plan and position symbols must match.",
      );
    }

    if (context.quote.symbol !== context.position.symbol) {
      throw new Error(
        "Quote and position symbols must match.",
      );
    }

    if (!Number.isFinite(context.atr) || context.atr <= 0) {
      throw new RangeError("ATR must be a finite positive number.");
    }

    if (
      !Number.isFinite(context.state.initialVolume) ||
      context.state.initialVolume <= 0
    ) {
      throw new RangeError(
        "Management state initialVolume must be positive.",
      );
    }
  }
}

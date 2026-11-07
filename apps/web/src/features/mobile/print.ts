/** A receipt to the chosen Bluetooth printer (prompt 43): `@gst/print`'s ESC/POS bytes, sent raw. */
import { receiptBytes, type PrintModel, type TemplateSpec } from '@gst/print';

import { chosenPrinter, printBytes } from '@/platform/printer';

export async function printReceipt(
  model: PrintModel,
  spec: TemplateSpec,
): Promise<'printed' | 'no_printer'> {
  const printer = await chosenPrinter();
  if (!printer) return 'no_printer';
  await printBytes(printer, receiptBytes(model, spec, { feedLines: 3 }));
  return 'printed';
}

import {
  Badge,
  Button,
  Card,
  Checkbox,
  Combobox,
  DatePicker,
  DensityToggle,
  EmptyState,
  GstinInput,
  Input,
  LanguageSwitcher,
  MoneyInput,
  MoneyText,
  PageHeader,
  PercentInput,
  StatusPill,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  ThemeToggle,
} from '@gst/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/books/_kit')({ component: Kit });

const rows = [
  { id: 'INV-001', party: 'Sharma Traders', amount: 12345600n, status: 'paid' as const },
  { id: 'INV-002', party: 'Iyer & Sons', amount: 4550000n, status: 'overdue' as const },
  { id: 'INV-003', party: 'Das Stores', amount: -250000n, status: 'draft' as const },
];

function Kit() {
  useEffect(() => {
    document.documentElement.setAttribute('data-density', 'compact');
  }, []);
  const [paise, setPaise] = useState<bigint | null>(12345600n);
  const [bp, setBp] = useState<number | null>(1800);
  const [gstin, setGstin] = useState('27AAPFU0939F1ZV');
  const [date, setDate] = useState<Date | null>(null);
  const [party, setParty] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="UI kit"
        description="Dense mode sample"
        actions={
          <>
            <LanguageSwitcher />
            <DensityToggle />
            <ThemeToggle />
          </>
        }
      />
      <div className="grid grid-cols-3 gap-3">
        <Card className="flex flex-col gap-2">
          <MoneyInput aria-label="Amount" value={paise} onValueChange={setPaise} />
          <PercentInput aria-label="GST rate" value={bp} onValueChange={setBp} />
          <GstinInput aria-label="GSTIN" value={gstin} onValueChange={setGstin} />
        </Card>
        <Card className="flex flex-col gap-2">
          <Input aria-label="Name" placeholder="Name" />
          <DatePicker value={date} onChange={(d) => setDate(d ?? null)} />
          <Combobox
            value={party}
            onChange={setParty}
            options={[
              { value: 'a', label: 'Sharma Traders' },
              { value: 'b', label: 'Iyer & Sons' },
            ]}
          />
        </Card>
        <Card className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Checkbox id="cess" />
            <label htmlFor="cess">Include cess</label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="rc" />
            <label htmlFor="rc">Reverse charge</label>
          </div>
          <div className="flex gap-2">
            <Button>Save</Button>
            <Button variant="outline">Cancel</Button>
            <Badge tone="info">New</Badge>
          </div>
        </Card>
      </div>
      <Table className="mt-3">
        <TableHead>
          <TableRow>
            <TableHeaderCell>No.</TableHeaderCell>
            <TableHeaderCell>Party</TableHeaderCell>
            <TableHeaderCell className="text-right">Amount</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.id}</TableCell>
              <TableCell>{r.party}</TableCell>
              <TableCell className="text-right">
                <MoneyText paise={r.amount} negativeRed />
              </TableCell>
              <TableCell>
                <StatusPill status={r.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <EmptyState
        title="No more documents"
        description="Create your first invoice to see it here."
      />
    </div>
  );
}

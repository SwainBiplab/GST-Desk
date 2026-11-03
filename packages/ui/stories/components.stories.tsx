import type { Meta, StoryObj } from '@storybook/react';
import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Calendar,
  Card,
  CardTitle,
  Checkbox,
  Combobox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DatePicker,
  DensityToggle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerContent,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  GstinInput,
  InboxCard,
  Input,
  LanguageSwitcher,
  MoneyInput,
  MoneyText,
  PageHeader,
  PercentInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  StatusPill,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ThemeToggle,
  Toaster,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TracePanel,
  VirtualList,
} from '../src';

const meta: Meta = { title: 'Kit' };
export default meta;
type S = StoryObj;

const story = (render: () => React.ReactElement): S => ({ render });

export const Buttons = story(() => (
  <div className="flex gap-2">
    <Button>Primary</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="danger">Danger</Button>
  </div>
));

export const TextFields = story(() => (
  <div className="flex max-w-sm flex-col gap-2">
    <Input aria-label="Name" placeholder="Name" />
    <Textarea aria-label="Notes" placeholder="Notes" />
  </div>
));

export const SelectStory = story(() => (
  <Select defaultValue="b2b">
    <SelectTrigger className="w-48" aria-label="Supply type">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="b2b">B2B</SelectItem>
      <SelectItem value="b2c">B2C</SelectItem>
    </SelectContent>
  </Select>
));
SelectStory.name = 'Select';

export const ComboboxStory = story(() => {
  const [v, setV] = React.useState<string | null>(null);
  return (
    <div className="w-64">
      <Combobox
        value={v}
        onChange={setV}
        options={[
          { value: 'a', label: 'Sharma Traders' },
          { value: 'b', label: 'Iyer & Sons' },
        ]}
      />
    </div>
  );
});
ComboboxStory.name = 'Combobox';

export const Choices = story(() => (
  <div className="flex flex-col gap-3">
    <label className="flex items-center gap-2">
      <Checkbox /> Include cess
    </label>
    <label className="flex items-center gap-2">
      <Switch aria-label="Reverse charge" /> Reverse charge
    </label>
    <RadioGroup defaultValue="a" aria-label="Mode" className="flex gap-4">
      <label className="flex items-center gap-2">
        <RadioGroupItem value="a" /> Cash
      </label>
      <label className="flex items-center gap-2">
        <RadioGroupItem value="b" /> UPI
      </label>
    </RadioGroup>
  </div>
));

export const Dialogs = story(() => (
  <div className="flex gap-2">
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Edit party</DialogTitle>
        <DialogDescription>Update details.</DialogDescription>
      </DialogContent>
    </Dialog>
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="danger">Cancel invoice</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Cancel this invoice?</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        <div className="flex justify-end gap-2 pt-3">
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction>Cancel invoice</AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetTitle>Details</SheetTitle>
        <SheetDescription>Side panel.</SheetDescription>
      </SheetContent>
    </Sheet>
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Drawer</Button>
      </DrawerTrigger>
      <DrawerContent>
        <SheetTitle>Actions</SheetTitle>
        <SheetDescription>Bottom drawer.</SheetDescription>
      </DrawerContent>
    </Drawer>
  </div>
));

export const Menus = story(() => (
  <div className="flex gap-4">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Menu</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <ContextMenu>
      <ContextMenuTrigger className="rounded-md border border-border p-6">
        Right-click
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Open</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>
));

export const Overlays = story(() => (
  <TooltipProvider>
    <div className="flex gap-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Helpful hint</TooltipContent>
      </Tooltip>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Popover</Button>
        </PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>
      <Toaster />
      <Button onClick={() => toast('Saved')}>Toast</Button>
    </div>
  </TooltipProvider>
));

export const TabsStory = story(() => (
  <Tabs defaultValue="a">
    <TabsList>
      <TabsTrigger value="a">Details</TabsTrigger>
      <TabsTrigger value="b">History</TabsTrigger>
    </TabsList>
    <TabsContent value="a">Details panel</TabsContent>
    <TabsContent value="b">History panel</TabsContent>
  </Tabs>
));
TabsStory.name = 'Tabs';

export const Display = story(() => (
  <div className="flex max-w-md flex-col gap-3">
    <Card>
      <CardTitle>Card</CardTitle>
      <p>Body text</p>
    </Card>
    <div className="flex gap-2">
      <Badge>Neutral</Badge>
      <Badge tone="success">Success</Badge>
      <Badge tone="warning">Warning</Badge>
      <Badge tone="danger">Danger</Badge>
      <Badge tone="info">Info</Badge>
    </div>
    <Skeleton className="h-4 w-40" />
    <Separator />
    <ScrollArea className="h-16">
      <p>Scrollable content that is long enough to overflow the box.</p>
      <p>Second paragraph.</p>
      <p>Third paragraph.</p>
    </ScrollArea>
  </div>
));

export const TableStory = story(() => (
  <Table>
    <TableHead>
      <TableRow>
        <TableHeaderCell>Item</TableHeaderCell>
        <TableHeaderCell className="text-right">Amount</TableHeaderCell>
      </TableRow>
    </TableHead>
    <TableBody>
      <TableRow>
        <TableCell>Widget</TableCell>
        <TableCell className="text-right">
          <MoneyText paise={1234500} />
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
));
TableStory.name = 'Table';

export const Dates = story(() => {
  const [d, setD] = React.useState<Date | null>(null);
  return (
    <div className="flex gap-6">
      <div className="w-48">
        <DatePicker value={d} onChange={(x) => setD(x ?? null)} />
      </div>
      <Calendar mode="single" />
    </div>
  );
});

export const Money = story(() => {
  const [p, setP] = React.useState<bigint | null>(12345600n);
  const [bp, setBp] = React.useState<number | null>(1800);
  const [g, setG] = React.useState('27AAPFU0939F1ZV');
  return (
    <div className="flex max-w-xs flex-col gap-2">
      <MoneyInput aria-label="Amount" value={p} onValueChange={setP} />
      <MoneyText paise={-250000} negativeRed />
      <PercentInput aria-label="Rate" value={bp} onValueChange={setBp} />
      <GstinInput aria-label="GSTIN" value={g} onValueChange={setG} />
    </div>
  );
});

export const Status = story(() => (
  <div className="flex flex-wrap gap-2">
    {(
      [
        'draft',
        'issued',
        'paid',
        'partial',
        'overdue',
        'cancelled',
        'synced',
        'pending',
        'syncing',
        'conflict',
        'offline',
      ] as const
    ).map((s) => (
      <StatusPill key={s} status={s} />
    ))}
  </div>
));

export const Shells = story(() => (
  <div className="flex max-w-xl flex-col gap-3">
    <PageHeader title="Invoices" description="All sales documents" actions={<Button>New</Button>} />
    <EmptyState title="Nothing here" description="Create your first document." />
    <TracePanel />
    <InboxCard title="Review needed" actions={<Button variant="outline">Open</Button>}>
      HSN looks unusual.
    </InboxCard>
  </div>
));

export const Toggles = story(() => (
  <div className="flex gap-2">
    <ThemeToggle />
    <DensityToggle />
    <LanguageSwitcher />
  </div>
));

export const VirtualListStory = story(() => (
  <VirtualList
    items={Array.from({ length: 10000 }, (_, i) => `Row ${i + 1}`)}
    height={160}
    renderItem={(t) => <div className="px-2">{t}</div>}
  />
));
VirtualListStory.name = 'VirtualList';

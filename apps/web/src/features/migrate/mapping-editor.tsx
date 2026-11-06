import type { FieldDef, Mapping } from '@gst/domain';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { dyn } from '@/lib/dyn-key';

const NONE = '__none__';

/** Which column of the file feeds each field. A required field with no column is marked. */
export function MappingEditor({
  fields,
  headers,
  mapping,
  onChange,
  testId,
}: {
  fields: readonly FieldDef[];
  headers: readonly string[];
  mapping: Mapping;
  onChange: (m: Mapping) => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <Table data-testid={testId}>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t('migrate.map.field')}</TableHeaderCell>
          <TableHeaderCell>{t('migrate.map.column')}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {fields.map((f) => {
          const value = mapping[f.key];
          const missing = f.required && (value === null || value === undefined);
          const label = t(dyn(`migrate.fields.${f.key}`), { defaultValue: f.key });
          return (
            <TableRow key={f.key}>
              <TableCell>
                {label}
                {f.required ? <span aria-hidden="true"> *</span> : null}
              </TableCell>
              <TableCell>
                <Select
                  value={value === null || value === undefined ? NONE : String(value)}
                  onValueChange={(v) =>
                    onChange({ ...mapping, [f.key]: v === NONE ? null : Number(v) })
                  }
                >
                  <SelectTrigger
                    className="w-64"
                    aria-label={label}
                    aria-invalid={missing || undefined}
                    data-testid={`map-${f.key}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('migrate.map.notMapped')}</SelectItem>
                    {headers.map((h, i) => (
                      <SelectItem key={`${i}-${h}`} value={String(i)}>
                        {h || t('migrate.map.blankColumn', { n: i + 1 })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

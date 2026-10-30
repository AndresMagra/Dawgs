import { useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { day, invoiceStage, money, todayKey, type Invoice } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, Line, P, Row, Screen, Segmented, Sheet, Stat, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt, confirm } from '../lib/alert';
import { orNull } from '../lib/sheets';
import { InvoiceSheet } from '../lib/invoices';

interface Summary {
  month: string;
  income: { category: string; total: number }[];
  cardFeesCents: number;
  expenses: { category: string; total: number }[];
  budgets: { category: string; amountCents: number }[];
  revenueCents: number;
  costsCents: number;
  profitCents: number;
  openInvoices: { n: number; total: number };
}
interface Expense {
  id: string;
  category: string;
  vendor: string;
  amountCents: number;
  dueDate: string;
  paidAt: string | null;
  note: string | null;
}
interface Item {
  id: string;
  name: string;
  sku: string | null;
  priceCents: number;
  costCents: number;
  onHand: number;
  reorderAt: number;
}

const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const CATEGORY: Record<string, string> = { daycare: 'Daycare', boarding: 'Boarding', packages: 'Packs & memberships', walks: 'Walks', training: 'Training', retail: 'Retail', other: 'Invoices' };

export default function MoneyScreen() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const [month, setMonth] = useState(todayKey(tz).slice(0, 7));
  const [tab, setTab] = useState<'summary' | 'invoices' | 'expenses' | 'inventory'>('summary');
  const [sheet, setSheet] = useState<null | 'expense' | 'budget' | 'item' | Item>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const sum = useLoad(() => api.get<Summary>(`/money/summary?month=${month}`), [month]);
  const open = useLoad(() => api.get<Invoice[]>('/invoices?status=open'), []);
  const exp = useLoad(() => api.get<Expense[]>('/expenses'), []);
  const inv = useLoad(() => api.get<Item[]>('/inventory'), []);
  const s = sum.data;
  const monthExpenses = (exp.data ?? []).filter((e) => e.dueDate.startsWith(month));

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Money' }} />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'summary', label: 'This month' },
          { value: 'invoices', label: `Unpaid${open.data?.length ? ` (${open.data.length})` : ''}` },
          { value: 'expenses', label: 'Expenses' },
          { value: 'inventory', label: 'Retail stock' },
        ]}
      />
      {tab === 'summary' || tab === 'expenses' ? (
        <Row>
          <Button small title="‹" onPress={() => setMonth(shiftMonth(month, -1))} />
          <P bold>{new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</P>
          <Button small title="›" onPress={() => setMonth(shiftMonth(month, 1))} />
        </Row>
      ) : null}

      {tab === 'summary' && s ? (
        <>
          <Row wrap>
            <Stat label="Taken in" value={money(s.revenueCents)} />
            <Stat label="Costs" value={money(s.costsCents)} />
            <Stat label="Profit" value={money(s.profitCents)} tone={s.profitCents >= 0 ? 'ok' : 'bad'} />
            <Stat label="Owed to you" value={money(s.openInvoices.total)} tone={s.openInvoices.n ? 'warn' : undefined} />
          </Row>
          <H2>Income</H2>
          <Card>
            {s.income.length === 0 ? <P muted>No payments this month.</P> : null}
            {s.income.map((r) => (
              <Line key={r.category} left={CATEGORY[r.category] ?? r.category} right={money(r.total)} />
            ))}
          </Card>
          <H2 right={<Button small title="Set budget" onPress={() => setSheet('budget')} />}>Spending against budget</H2>
          <Card>
            {[...new Set([...s.expenses.map((e) => e.category), ...s.budgets.map((b) => b.category)])].map((c) => {
              const spent = s.expenses.find((e) => e.category === c)?.total ?? 0;
              const plan = s.budgets.find((b) => b.category === c)?.amountCents;
              return (
                <View key={c} style={{ gap: 4 }}>
                  <Line left={c} right={`${money(spent)}${plan ? ` of ${money(plan)}` : ''}`} />
                  {plan ? (
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: '#e4e4e7' }}>
                      <View style={{ height: 6, borderRadius: 3, width: `${Math.min(100, (spent / plan) * 100)}%`, backgroundColor: spent > plan ? '#dc2626' : '#16a34a' }} />
                    </View>
                  ) : null}
                </View>
              );
            })}
            <Line left="Card processing fees" right={money(s.cardFeesCents)} muted />
          </Card>
        </>
      ) : null}

      {tab === 'invoices' ? (
        <>
          {open.data?.length === 0 ? <Empty text="Nothing unpaid." /> : null}
          {open.data?.map((i) => (
            <Card key={i.id} onPress={() => setInvoice(i.id)}>
              <Row between>
                <View>
                  <P bold>
                    #{i.number} · {i.ownerName} · {money(i.totalCents)}
                  </P>
                  <P small muted>
                    {day(i.createdAt, tz)} · {CATEGORY[i.category] ?? i.category}
                    {i.dueDate ? ` · due ${i.dueDate}` : ''}
                  </P>
                </View>
                <Chip {...invoiceStage(i, todayKey(tz))} />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'expenses' ? (
        <>
          <Button variant="primary" title="Add expense" onPress={() => setSheet('expense')} />
          {monthExpenses.length === 0 ? <Empty text="No expenses this month." /> : null}
          {monthExpenses.map((e) => (
            <Card key={e.id}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <P bold>
                    {e.vendor} · {money(e.amountCents)}
                  </P>
                  <P small muted>
                    {e.category} · due {e.dueDate}
                    {e.note ? ` · ${e.note}` : ''}
                  </P>
                </View>
                <Row>
                  <Button small variant={e.paidAt ? 'secondary' : 'primary'} title={e.paidAt ? 'Paid ✓' : 'Mark paid'} onPress={async () => (await attempt(() => api.patch(`/expenses/${e.id}`, { paid: !e.paidAt }))) && void exp.reload()} />
                  <Button small variant="ghost" title="Delete" onPress={async () => (await confirm('Delete expense?', e.vendor)) && (await attempt(() => api.del(`/expenses/${e.id}`))) && (void exp.reload(), void sum.reload())} />
                </Row>
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'inventory' ? (
        <>
          <Button variant="primary" title="Add item" onPress={() => setSheet('item')} />
          {inv.data?.map((i) => (
            <Card key={i.id} onPress={() => setSheet(i)}>
              <Row between>
                <View>
                  <P bold>{i.name}</P>
                  <P small muted>
                    {money(i.priceCents)} · cost {money(i.costCents)}
                    {i.sku ? ` · ${i.sku}` : ''}
                  </P>
                </View>
                <Chip text={`${i.onHand} on hand`} tone={i.onHand <= i.reorderAt ? 'warn' : 'ok'} />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      <InvoiceSheet invoiceId={invoice} onClose={() => setInvoice(null)} onDone={() => (void open.reload(), void sum.reload())} />
      <ExpenseSheet open={sheet === 'expense'} month={month} onClose={() => setSheet(null)} onDone={() => (setSheet(null), void exp.reload(), void sum.reload())} />
      <BudgetSheet open={sheet === 'budget'} month={month} onClose={() => setSheet(null)} onDone={() => (setSheet(null), void sum.reload())} />
      {sheet === 'item' || (sheet && typeof sheet === 'object') ? (
        <ItemSheet item={sheet === 'item' ? null : sheet} onClose={() => setSheet(null)} onDone={() => (setSheet(null), void inv.reload())} />
      ) : null}
    </Screen>
  );
}

function ExpenseSheet({ open, month, onClose, onDone }: { open: boolean; month: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ vendor: '', category: 'Supplies', amount: '', dueDate: `${month}-01`, note: '' });
  const [paid, setPaid] = useState(true);
  return (
    <Sheet visible={open} onClose={onClose} title="Add expense">
      <Field label="Vendor" value={f.vendor} onChangeText={(x) => setF({ ...f, vendor: x })} />
      <Field label="Category (Rent, Payroll, Supplies, Food…)" value={f.category} onChangeText={(x) => setF({ ...f, category: x })} />
      <Field label="Amount ($)" value={f.amount} onChangeText={(x) => setF({ ...f, amount: x })} keyboardType="numeric" />
      <Field label="Date (YYYY-MM-DD)" value={f.dueDate} onChangeText={(x) => setF({ ...f, dueDate: x })} />
      <Field label="Note" value={f.note} onChangeText={(x) => setF({ ...f, note: x })} />
      <Toggle label="Already paid" value={paid} onChange={setPaid} />
      <Button
        variant="primary"
        title="Save"
        disabled={!f.vendor.trim() || !Number(f.amount)}
        onPress={async () => {
          const e = await attempt(() => api.post<{ id: string }>('/expenses', { vendor: f.vendor.trim(), category: f.category.trim(), amountCents: Math.round(Number(f.amount) * 100), dueDate: f.dueDate, note: orNull(f.note) }));
          if (!e) return;
          if (paid) await attempt(() => api.patch(`/expenses/${e.id}`, { paid: true }));
          setF({ ...f, vendor: '', amount: '', note: '' });
          onDone();
        }}
      />
    </Sheet>
  );
}

function BudgetSheet({ open, month, onClose, onDone }: { open: boolean; month: string; onClose: () => void; onDone: () => void }) {
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  return (
    <Sheet visible={open} onClose={onClose} title={`Budget for ${month}`}>
      <Field label="Category" value={category} onChangeText={setCategory} />
      <Field label="Monthly budget ($)" value={amount} onChangeText={setAmount} keyboardType="numeric" />
      <Button variant="primary" title="Save" disabled={!category.trim()} onPress={async () => (await attempt(() => api.put('/budgets', { month, category: category.trim(), amountCents: Math.round(Number(amount) * 100) }))) && onDone()} />
    </Sheet>
  );
}

function ItemSheet({ item, onClose, onDone }: { item: Item | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: item?.name ?? '',
    sku: item?.sku ?? '',
    price: item ? String(item.priceCents / 100) : '',
    cost: item ? String(item.costCents / 100) : '',
    onHand: String(item?.onHand ?? 0),
    reorderAt: String(item?.reorderAt ?? 3),
  });
  return (
    <Sheet visible onClose={onClose} title={item ? item.name : 'New item'}>
      <Field label="Name" value={f.name} onChangeText={(x) => setF({ ...f, name: x })} />
      <Field label="SKU / barcode" value={f.sku} onChangeText={(x) => setF({ ...f, sku: x })} />
      <Row>
        <Field label="Price ($)" value={f.price} onChangeText={(x) => setF({ ...f, price: x })} keyboardType="numeric" />
        <Field label="Cost ($)" value={f.cost} onChangeText={(x) => setF({ ...f, cost: x })} keyboardType="numeric" />
      </Row>
      <Row>
        <Field label="On hand" value={f.onHand} onChangeText={(x) => setF({ ...f, onHand: x })} keyboardType="numeric" />
        <Field label="Reorder at" value={f.reorderAt} onChangeText={(x) => setF({ ...f, reorderAt: x })} keyboardType="numeric" />
      </Row>
      <Button
        variant="primary"
        title="Save"
        disabled={!f.name.trim()}
        onPress={async () => {
          const body = { name: f.name.trim(), sku: orNull(f.sku), priceCents: Math.round(Number(f.price) * 100), costCents: Math.round(Number(f.cost) * 100), onHand: Number(f.onHand), reorderAt: Number(f.reorderAt) };
          if (await attempt(() => (item ? api.patch(`/inventory/${item.id}`, body) : api.post('/inventory', body)))) onDone();
        }}
      />
    </Sheet>
  );
}

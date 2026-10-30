import { Button, Row } from './components';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Pick days of the week for a repeating booking; 0 is Sunday. */
export function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <Row wrap>
      {[1, 2, 3, 4, 5, 6, 0].map((d) => (
        <Button key={d} small title={DAYS[d]!} variant={value.includes(d) ? 'primary' : 'secondary'} onPress={() => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d])} />
      ))}
    </Row>
  );
}

export const weekdayNames = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAYS[d]).join(', ');

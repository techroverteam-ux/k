import { useState } from 'react';
import { View } from 'react-native';
import { ACTIVITY_FIELDS, actionLabel, deviceLabel, stamp, type ActivityEntry } from '@/activity';
import { Button, Empty, ErrorState, IconMark, ListRow, Row, Screen, Skeleton, T, useQuery } from '@/ui';

/** Your own sign-ins and actions with time, IP address and device. */
export default function Activity() {
  const [before, setBefore] = useState<string[]>([]);
  const { data, error, loading, refetch } = useQuery<{ myActivity: ActivityEntry[] }>(`query($b:String){ myActivity(limit:30, beforeId:$b){ ${ACTIVITY_FIELDS} } }`, { b: before[before.length - 1] });
  const rows = data?.myActivity ?? [];
  return (
    <Screen title="Account activity" back onRefresh={refetch}>
      <T v="sm" c="text2">Every sign-in and action on your account, with time, IP address and device. If something looks unfamiliar, change your password and sign out other devices.</T>
      {loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="file" title="No activity yet" /> : (
        <View>
          {rows.map((r) => (
            <ListRow key={r.id} left={<IconMark icon={r.outcome === 'ERROR' ? 'alert' : 'shield'} tone={r.outcome === 'ERROR' ? 'neg' : undefined} />}
              title={`${actionLabel(r.opName, r.fields)}${r.outcome === 'ERROR' ? ' (failed)' : ''}`}
              sub={<View style={{ gap: 2 }}><T v="xs">{stamp(r.at)}</T><T v="xs">IP {r.ip} · {deviceLabel(r.userAgent)}</T></View>} />
          ))}
        </View>
      )}
      {(rows.length === 30 || before.length > 0) && (
        <Row>
          <Button block size="sm" title="Newer" disabled={!before.length} onPress={() => setBefore((b) => b.slice(0, -1))} />
          <Button block size="sm" title="Older" disabled={rows.length < 30} onPress={() => setBefore((b) => [...b, rows[rows.length - 1].id])} />
        </Row>
      )}
    </Screen>
  );
}

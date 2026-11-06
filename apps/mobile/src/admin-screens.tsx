/**
 * Super Admin tools on mobile: accounts (create, approve, suspend/reactivate, assign broker, reset password,
 * sign out), security (audit chain check, reconciliation, sign-in and consent logs), and the broker's
 * commissions report. Sensitive actions ask for step-up verification through the API, like on the web.
 * Configuration changes and log archives stay on the web portal.
 */
import { useSoleAdmin } from './sole-admin';
import { router } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { CONSENT_FIELDS, deviceLabel, LOGIN_FIELDS, LOGIN_LABEL, stamp, type ConsentRecord, type LoginEvent } from './activity';
import { gql } from './api';
import { useAuth } from './auth';
import { Icon } from './icons';
import { BellButton, LoginHistoryList, MfaSetupSheet } from './screens';
import { inr, initials, R, S, useTheme, when } from './theme';
import {
  Badge, Button, Chips, Empty, ErrorState, Field, IconMark, Lines, ListRow, Metrics, Notice, Row, Screen, SearchBox, Section, Sheet, Skeleton, Spread,
  StatusBadge, T, Tabs, toast, useQuery, VList,
} from './ui';

export const USER_FIELDS = 'id username displayName role status mode isDemo brokerId brokerName createdByName openingAmount commissionPct commissionPerMiniLot commissionPerMegaLot commissionIsDefault mfaEnabled createdAt phone';
export interface UserRow { id: string; username: string; displayName: string; role: 'SUPER_ADMIN' | 'BROKER' | 'TRADER'; status: string; isDemo?: boolean; brokerId?: string; brokerName?: string; createdByName?: string; openingAmount?: string; commissionPct?: string; commissionPerMiniLot?: string; commissionPerMegaLot?: string; commissionIsDefault?: boolean; mfaEnabled: boolean; createdAt: string; phone?: string }
const ROLE: Record<string, string> = { SUPER_ADMIN: 'Super Admin', BROKER: 'Broker', TRADER: 'Trader' };
const useBrokers = () => useQuery<{ users: { items: { id: string; username: string; displayName: string }[] } }>(`{ users(role:BROKER, status:ACTIVE, limit:100){ items{ id username displayName } } }`);

/* ============================================================== MFA gate */
/** Admin tools need two-step verification; set it up right here instead of sending people to the web. */
export function AdminMfaGate({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Screen title={title}>
      <Notice tone="warn">Administrator accounts must use two-step verification before they can use admin tools.</Notice>
      <Button kind="primary" size="lg" icon="shield" title="Set up two-step verification" onPress={() => setOpen(true)} />
      {open && <MfaSetupSheet onClose={() => setOpen(false)} />}
    </Screen>
  );
}

/* ============================================================== users */
const UserItem = memo(function UserItem({ u, broker }: { u: UserRow; broker?: string }) {
  const t = useTheme();
  return (
    <ListRow onPress={() => router.push(`/admin-user/${u.id}`)} label={`${u.displayName}, ${ROLE[u.role]}, ${u.status}`}
      left={<View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T v="sm" c="brand" w="700">{initials(u.displayName)}</T></View>}
      title={<Row gap={6}><T w="600" numberOfLines={1} style={{ flexShrink: 1 }}>{u.displayName}</T>{u.isDemo ? <Badge text="Demo" /> : null}</Row>}
      sub={`${u.username} · ${ROLE[u.role]}${u.brokerName ?? broker ? ` · broker ${u.brokerName ?? broker}` : ''}${u.status === 'PENDING' ? `\nRequested ${when(u.createdAt)}${u.createdByName ? ` by ${u.createdByName}` : ''}${u.openingAmount ? ` · opening ₹${inr(u.openingAmount)}` : ''}` : ''}`}
      right={<StatusBadge v={u.status} />} />
  );
});

export function AdminUsersScreen() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [role, setRole] = useState<'' | 'TRADER' | 'BROKER' | 'SUPER_ADMIN'>('');
  const [status, setStatus] = useState<'' | 'PENDING' | 'ACTIVE' | 'SUSPENDED'>('');
  const [create, setCreate] = useState(false);
  const list = useQuery<{ users: { total: number; items: UserRow[] } }>(
    `query($r:Role,$s:UserStatus,$q:String){ users(role:$r, status:$s, search:$q, limit:100, offset:0){ total items{ ${USER_FIELDS} } } }`,
    { r: role || undefined, s: status || undefined, q: q.trim() || undefined }, 30000, !me?.mfaEnabled,
  );
  const brokers = useBrokers();
  const name = useCallback((id?: string) => brokers.data?.users.items.find((b) => b.id === id)?.username, [brokers.data]);
  if (!me?.mfaEnabled) return <AdminMfaGate title="Accounts" />;
  const items = list.data?.users.items ?? [];
  const header = (
    <>
      <PendingDeletions onDeleted={() => void list.refetch()} />
      <SearchBox value={q} onChangeText={setQ} placeholder="Search name or username" />
      <Chips value={status} onChange={setStatus} items={[{ k: '', label: 'All' }, { k: 'PENDING', label: 'Pending' }, { k: 'ACTIVE', label: 'Active' }, { k: 'SUSPENDED', label: 'Suspended' }]} />
      <Chips value={role} onChange={setRole} items={[{ k: '', label: 'Every role' }, { k: 'TRADER', label: 'Traders' }, { k: 'BROKER', label: 'Brokers' }, { k: 'SUPER_ADMIN', label: 'Admins' }]} />
      <Spread><T v="xs">{list.data ? `${list.data.users.total} account${list.data.users.total === 1 ? '' : 's'}${list.data.users.total > items.length ? `, showing ${items.length}` : ''}` : ' '}</T><Button size="sm" kind="primary" icon="plus" title="New account" onPress={() => setCreate(true)} /></Spread>
    </>
  );
  const empty = list.loading && !list.data ? <Skeleton /> : list.error && !list.data ? <ErrorState error={list.error} retry={list.refetch} /> : <Empty icon="users" title="No accounts match">Try another filter.</Empty>;
  return (
    <Screen title="Accounts" scroll={false} right={<BellButton />}>
      <VList data={items} keyOf={(u) => u.id} header={header} empty={empty} render={(u) => <UserItem u={u} broker={name(u.brokerId)} />} />
      {create && <CreateUserSheet brokers={brokers.data?.users.items ?? []} onClose={() => setCreate(false)} onDone={() => void list.refetch()} />}
    </Screen>
  );
}

/** New account. A broker uses it to ask for a trader account (with the opening amount); a Super Admin approves it. */
export function CreateUserSheet({ brokers, onClose, onDone }: { brokers: { id: string; username: string }[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ username: '', displayName: '', role: 'TRADER' as 'TRADER' | 'BROKER', phone: '', brokerId: '', tempPassword: '', commMini: '', commMega: '', openingAmount: '' });
  const sole = useSoleAdmin();
  const { me, settings } = useAuth();
  const asBroker = me?.role === 'BROKER';
  const minOpen = Number(settings?.minDeposit ?? 50000);
  const minLabel = minOpen.toLocaleString('en-IN');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const errs = {
    username: !/^[a-z][a-z0-9_.@#-]{3,39}$/.test(f.username.trim().toLowerCase()) ? '4–40 characters starting with a letter: letters, digits and _ . - @ #' : null,
    displayName: !f.displayName.trim() ? 'Enter a name' : null,
    phone: f.phone && !/^[6-9]\d{9}$/.test(f.phone) ? 'Enter a 10-digit mobile number' : null,
    tempPassword: f.tempPassword.length < 10 ? 'At least 10 characters' : null,
    commMini: f.role === 'BROKER' && f.commMini.trim() && !/^\d{1,7}(\.\d{1,2})?$/.test(f.commMini.trim()) ? 'Enter rupees, e.g. 170' : null,
    commMega: f.role === 'BROKER' && f.commMega.trim() && !/^\d{1,7}(\.\d{1,2})?$/.test(f.commMega.trim()) ? 'Enter rupees, e.g. 1700' : null,
    openingAmount: f.role === 'TRADER' && (asBroker || f.openingAmount.trim()) && !(/^\d{1,12}(\.\d{1,2})?$/.test(f.openingAmount.trim()) && Number(f.openingAmount) >= minOpen) ? `Enter at least ₹${minLabel}` : null,
  };
  const bad = Object.values(errs).some(Boolean);
  const e = (k: keyof typeof errs) => (touched ? errs[k] : null);
  return (
    <Sheet visible title={asBroker ? 'Add trader' : 'New account'} sub={asBroker ? 'Sent to the Super Admin. When they approve, the trader can sign in and the opening amount is added to their balance.' : sole ? 'It can sign in straight away.' : 'It can sign in after a Super Admin approves it.'} onClose={onClose}>
      {!asBroker && <Chips value={f.role} onChange={(role) => setF({ ...f, role })} items={[{ k: 'TRADER', label: 'Trader' }, { k: 'BROKER', label: 'Broker' }]} />}
      <Field label="Full name" value={f.displayName} maxLength={120} onChangeText={(v) => setF({ ...f, displayName: v })} error={e('displayName')} />
      <Field label="Username" autoCapitalize="none" autoCorrect={false} value={f.username} onChangeText={(v) => setF({ ...f, username: v.toLowerCase() })} error={e('username')} />
      <Field label="Mobile (optional)" keyboardType="phone-pad" maxLength={10} value={f.phone} onChangeText={(v) => setF({ ...f, phone: v.replace(/\D/g, '') })} error={e('phone')} />
      {f.role === 'BROKER' && <Field label="Broker earns per mini lot (₹)" keyboardType="decimal-pad" placeholder="170" maxLength={10} value={f.commMini} onChangeText={(v) => setF({ ...f, commMini: v.replace(/[^\d.]/g, '') })} error={e('commMini')} hint="For every lot their traders open or cut. Empty: platform default." />}
      {f.role === 'BROKER' && <Field label="Broker earns per mega lot (₹)" keyboardType="decimal-pad" placeholder="1700" maxLength={10} value={f.commMega} onChangeText={(v) => setF({ ...f, commMega: v.replace(/[^\d.]/g, '') })} error={e('commMega')} />}
      {f.role === 'TRADER' && brokers.length > 0 && (
        <View style={{ gap: 6 }}><T v="sm" c="text2" w="500">Broker</T><Chips value={f.brokerId} onChange={(brokerId) => setF({ ...f, brokerId })} items={[{ k: '', label: 'None' }, ...brokers.map((b) => ({ k: b.id, label: b.username }))]} /></View>
      )}
      {f.role === 'TRADER' && <Field label={`Opening amount (₹)${asBroker ? '' : ' — optional'}`} keyboardType="decimal-pad" placeholder={minLabel} maxLength={15} value={f.openingAmount} onChangeText={(v) => setF({ ...f, openingAmount: v.replace(/[^\d.]/g, '') })} error={e('openingAmount')} hint={`Minimum ₹${minLabel}. Added to the trader’s balance when the account is approved.`} />}
      <Field label="Temporary password" secureTextEntry textContentType="newPassword" value={f.tempPassword} onChangeText={(v) => setF({ ...f, tempPassword: v })} error={e('tempPassword')} hint="Use three of: lowercase, uppercase, digits, symbols. Share it privately." />
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title={asBroker ? 'Send for approval' : 'Create account'} busy={busy} onPress={async () => {
        setTouched(true);
        if (bad) return;
        setBusy(true); setErr(null);
        try {
          const d = await gql<{ createUser: { status: string } }>(`mutation($i:CreateUserInput!){ createUser(input:$i){ id status } }`, { i: { username: f.username, displayName: f.displayName, role: f.role, phone: f.phone || undefined, brokerId: f.role === 'TRADER' && f.brokerId ? f.brokerId : undefined, tempPassword: f.tempPassword, commissionPerMiniLot: f.role === 'BROKER' && f.commMini.trim() ? f.commMini.trim() : undefined, commissionPerMegaLot: f.role === 'BROKER' && f.commMega.trim() ? f.commMega.trim() : undefined, openingAmount: f.role === 'TRADER' && f.openingAmount.trim() ? f.openingAmount.trim() : undefined } });
          toast(d.createUser.status === 'ACTIVE' ? 'Account created and active' : asBroker ? 'Request sent to the Super Admin' : 'Account created and sent for approval'); onDone(); onClose();
        } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}

/* ============================================================== one account */
type Action = 'approve' | 'suspend' | 'reactivate' | 'broker' | 'password' | 'signout' | 'delete' | 'commission';
export function AdminUserScreen({ id }: { id: string }) {
  const sole = useSoleAdmin();
  const t = useTheme();
  const { me } = useAuth();
  const u = useQuery<{ user: UserRow }>(`query($id:ID!){ user(id:$id){ ${USER_FIELDS} } }`, { id });
  const brokers = useBrokers();
  const [act, setAct] = useState<Action | null>(null);
  const [tab, setTab] = useState<'logins' | 'sessions'>('logins');
  const x = u.data?.user;
  if (!me?.mfaEnabled) return <AdminMfaGate title="Account" />;
  if (!x) return <Screen back title="Account">{u.error ? <ErrorState error={u.error} retry={u.refetch} /> : <Skeleton />}</Screen>;
  const self = x.id === me.id;
  const brokerName = brokers.data?.users.items.find((b) => b.id === x.brokerId);
  return (
    <Screen back title={x.displayName}>
      <PendingDeletions userId={x.id} onDeleted={() => router.back()} />
      <Row>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T v="h3" c="brand">{initials(x.displayName)}</T></View>
        <View style={{ flex: 1, gap: 4 }}><T v="h2">{x.displayName}</T><Row gap={S[2]}><T v="sm" c="text2">{x.username} · {ROLE[x.role]}</T><StatusBadge v={x.status} /></Row></View>
      </Row>
      <Lines lines={[
        [x.status === 'PENDING' ? 'Requested' : 'Created', `${when(x.createdAt)}${x.createdByName ? ` by ${x.createdByName}` : ''}`], ['Two-step verification', x.mfaEnabled ? 'On' : 'Off'],
        ...(x.status === 'PENDING' && x.openingAmount ? [['Opening amount', `₹${inr(x.openingAmount)}`] as [string, string]] : []),
        ...(x.role === 'TRADER' ? [['Broker', brokerName ? `${brokerName.displayName} (${brokerName.username})` : x.brokerName ?? 'None'] as [string, string]] : []),
        ...(x.role === 'BROKER' ? [['Commission', x.commissionPerMiniLot ? `₹${inr(x.commissionPerMiniLot)} per mini lot · ₹${inr(x.commissionPerMegaLot)} per mega lot${x.commissionIsDefault ? ' (default)' : ''}` : '—'] as [string, string]] : []),
        ...(x.phone ? [['Mobile', x.phone] as [string, string]] : []),
      ]} />
      {self ? <Notice>This is your own account. Use Profile to change your password or devices.</Notice> : (
        <Section title="Actions">
          {x.status === 'PENDING' && <ActionRow icon="check" tone="pos" label="Approve account" sub={x.openingAmount ? `Lets them sign in and adds ₹${inr(x.openingAmount)}` : 'Lets them sign in'} onPress={() => setAct('approve')} />}
          {x.status === 'ACTIVE' && <ActionRow icon="lock" tone="neg" label="Suspend account" sub="Signs them out and blocks sign-in" onPress={() => setAct('suspend')} />}
          {x.status === 'SUSPENDED' && <ActionRow icon="check" tone="pos" label="Reactivate account" sub="Lets them sign in again" onPress={() => setAct('reactivate')} />}
          {x.role === 'BROKER' && <ActionRow icon="briefcase" label="Change commission" sub={x.commissionPerMiniLot ? `Now ₹${inr(x.commissionPerMiniLot)} mini · ₹${inr(x.commissionPerMegaLot)} mega` : 'Per mini and mega lot'} onPress={() => setAct('commission')} />}
          {x.role === 'TRADER' && <ActionRow icon="users" label="Assign broker" sub={brokerName ? `Now: ${brokerName.username}` : 'No broker yet'} onPress={() => setAct('broker')} />}
          {!x.isDemo && <ActionRow icon="key" label="Reset password" sub="Set a temporary password and sign them out" onPress={() => setAct('password')} />}
          <ActionRow icon="device" label="Sign out everywhere" sub="Ends all their sessions" onPress={() => setAct('signout')} />
          {x.role === 'TRADER' && <ActionRow icon="briefcase" label="View trading account" sub="Positions, orders, ledger and fund requests" onPress={() => router.push(`/trader-detail/${x.id}`)} />}
          {x.role !== 'SUPER_ADMIN' && <ActionRow icon="alert" tone="neg" label="Delete permanently" sub={sole ? 'Erases the account and all its data right away' : 'Erases the account and all its data; a second Super Admin approves'} onPress={() => setAct('delete')} />}
        </Section>
      )}
      <UserWipes userId={x.id} />
      <Tabs value={tab} onChange={setTab} items={[{ k: 'logins', label: 'Sign-ins' }, { k: 'sessions', label: 'Devices' }]} />
      {tab === 'logins' ? <LoginHistoryList userId={x.id} /> : <UserSessions userId={x.id} />}
      {act && <UserActionSheet act={act} u={x} brokers={brokers.data?.users.items ?? []} onClose={() => setAct(null)} onDone={() => { setAct(null); void u.refetch(); }} />}
    </Screen>
  );
}

function ActionRow({ icon, label, sub, onPress, tone }: { icon: 'check' | 'lock' | 'users' | 'key' | 'device' | 'briefcase' | 'alert'; label: string; sub: string; onPress: () => void; tone?: 'pos' | 'neg' }) {
  const t = useTheme();
  return <ListRow onPress={onPress} label={label} left={<IconMark icon={icon} tone={tone} />} title={<T w="600" c={tone === 'neg' ? 'neg' : 'text'}>{label}</T>} sub={sub} right={<Icon name="chevronRight" size={18} color={t.text3} />} />;
}

function UserSessions({ userId }: { userId: string }) {
  const q = useQuery<{ userSessions: { id: string; deviceName?: string; ip?: string; userAgent?: string; lastUsedAt: string }[] }>(`query($u:ID!){ userSessions(userId:$u){ id deviceName ip userAgent lastUsedAt } }`, { u: userId });
  if (q.loading && !q.data) return <Skeleton rows={2} />;
  if (q.error && !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data?.userSessions.length) return <Empty icon="device" title="Not signed in anywhere" />;
  return (
    <View>
      {q.data.userSessions.map((s) => (
        <ListRow key={s.id} left={<IconMark icon="device" />} title={s.deviceName ?? deviceLabel(s.userAgent)} sub={`${s.ip ?? ''} · last active ${when(s.lastUsedAt)}`}
          right={<Button size="sm" kind="danger" title="Sign out" onPress={async () => {
            try { await gql(`mutation($u:ID!,$s:ID){ revokeUserSessions(userId:$u, sessionId:$s) }`, { u: userId, s: s.id }); toast('Device signed out'); } catch (e) { toast((e as Error).message, true); }
            void q.refetch();
          }} />} />
      ))}
    </View>
  );
}

function UserActionSheet({ act, u, brokers, onClose, onDone }: { act: Action; u: UserRow; brokers: { id: string; username: string; displayName: string }[]; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [broker, setBroker] = useState(u.brokerId ?? '');
  const [pw, setPw] = useState(act === 'commission' && u.commissionPerMegaLot ? String(Number(u.commissionPerMegaLot)) : '');
  const [typed, setTyped] = useState(act === 'commission' && u.commissionPerMiniLot ? String(Number(u.commissionPerMiniLot)) : '');
  const sole = useSoleAdmin();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (q: string, v: Record<string, unknown>, ok: string | ((d: Record<string, { status?: string } | undefined>) => string)) => {
    setBusy(true); setErr(null);
    try { const d = await gql(q, v); toast(typeof ok === 'string' ? ok : ok(d)); if (act === 'delete' && d?.requestUserDeletion?.status === 'EXECUTED') { router.back(); return; } onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const title = { approve: 'Approve account?', suspend: 'Suspend account?', reactivate: 'Reactivate account?', broker: 'Assign broker', password: 'Reset password', signout: 'Sign out everywhere?', delete: 'Delete permanently?', commission: 'Change commission' }[act];
  return (
    <Sheet visible title={title} sub={`${u.displayName} (${u.username})`} onClose={onClose}>
      {act === 'approve' && <T c="text2">{u.openingAmount ? `They can sign in as soon as you approve, and ₹${inr(u.openingAmount)} is added to their balance.` : 'They can sign in as soon as you approve.'}</T>}
      {act === 'approve' && <Lines lines={[['Type', ROLE[u.role]], ...(u.brokerName ? [['Broker', u.brokerName] as [string, string]] : []), ...(u.createdByName ? [['Requested by', u.createdByName] as [string, string]] : []), ['Requested on', when(u.createdAt)], ...(u.openingAmount ? [['Opening amount', `₹${inr(u.openingAmount)}`] as [string, string]] : [])]} />}
      {(act === 'suspend' || act === 'reactivate') && <Field label="Reason (recorded in the audit log)" value={reason} onChangeText={setReason} maxLength={200} hint="At least 5 characters" />}
      {act === 'broker' && <Chips value={broker} onChange={setBroker} items={[{ k: '', label: 'No broker' }, ...brokers.map((b) => ({ k: b.id, label: b.username }))]} />}
      {act === 'password' && <Field label="Temporary password" secureTextEntry textContentType="newPassword" value={pw} onChangeText={setPw} hint="At least 10 characters. They’ll be signed out and should change it after signing in." />}
      {act === 'signout' && <T c="text2">Every device signed in as this user is signed out now.</T>}
      {act === 'commission' && <Field label="Per mini lot (₹)" keyboardType="decimal-pad" placeholder={u.commissionPerMiniLot ? String(Number(u.commissionPerMiniLot)) : '170'} maxLength={10} value={typed} onChangeText={(v) => setTyped(v.replace(/[^\d.]/g, ''))} hint="What the broker earns for every lot their traders open or cut." />}
      {act === 'commission' && <Field label="Per mega lot (₹)" keyboardType="decimal-pad" placeholder={u.commissionPerMegaLot ? String(Number(u.commissionPerMegaLot)) : '1700'} maxLength={10} value={pw} onChangeText={(v) => setPw(v.replace(/[^\d.]/g, ''))} />}
      {act === 'delete' && (<>
        <Notice tone="err">{`Orders, positions, ledger, fund and fee requests, strategies, watchlist, notifications and sign-ins of ${u.username} are erased and can’t be brought back. ${u.role === 'BROKER' ? 'Their traders stay, without a broker. ' : ''}${sole ? 'This happens right away.' : 'A different Super Admin must approve within 30 minutes.'}`}</Notice>
        <Field label="Reason (recorded in the audit log)" value={reason} onChangeText={setReason} maxLength={300} hint="10–300 characters" />
        <Field label={`Type ${u.username} to confirm`} autoCapitalize="none" autoCorrect={false} value={typed} onChangeText={setTyped} />
      </>)}
      {err && <Notice tone="err">{err}</Notice>}
      <Row>
        <Button block title="Cancel" onPress={onClose} />
        {act === 'approve' && <Button block kind="primary" title="Approve" busy={busy} onPress={() => run(`mutation($id:ID!){ approveUser(userId:$id){ id } }`, { id: u.id }, u.openingAmount ? `Account approved and ₹${inr(u.openingAmount)} added` : 'Account approved')} />}
        {act === 'suspend' && <Button block kind="sell" title="Suspend" busy={busy} disabled={reason.trim().length < 5} onPress={() => run(`mutation($id:ID!,$s:UserStatus!,$r:String!){ setUserStatus(userId:$id, status:$s, reason:$r){ id } }`, { id: u.id, s: 'SUSPENDED', r: reason.trim() }, 'Account suspended')} />}
        {act === 'reactivate' && <Button block kind="primary" title="Reactivate" busy={busy} disabled={reason.trim().length < 5} onPress={() => run(`mutation($id:ID!,$s:UserStatus!,$r:String!){ setUserStatus(userId:$id, status:$s, reason:$r){ id } }`, { id: u.id, s: 'ACTIVE', r: reason.trim() }, 'Account reactivated')} />}
        {act === 'broker' && <Button block kind="primary" title="Save" busy={busy} disabled={broker === (u.brokerId ?? '')} onPress={() => run(`mutation($t:ID!,$b:ID){ assignTraderToBroker(traderId:$t, brokerId:$b){ id } }`, { t: u.id, b: broker || null }, 'Broker updated')} />}
        {act === 'password' && <Button block kind="primary" title="Reset" busy={busy} disabled={pw.length < 10} onPress={() => run(`mutation($id:ID!,$p:String!){ resetUserPassword(userId:$id, tempPassword:$p) }`, { id: u.id, p: pw }, 'Password reset; they were signed out')} />}
        {act === 'delete' && <Button block kind="sell" title={sole ? 'Delete now' : 'Ask to delete'} busy={busy} disabled={reason.trim().length < 10 || typed.trim().toLowerCase() !== u.username} onPress={() => run(`mutation($u:ID!,$r:String!,$w:String!){ requestUserDeletion(userId:$u, reason:$r, confirm:$w){ id status } }`, { u: u.id, r: reason.trim(), w: typed.trim() }, (d) => (d.requestUserDeletion?.status === 'EXECUTED' ? `${u.username} deleted` : 'Sent to another Super Admin for approval'))} />}
        {act === 'commission' && <Button block kind="primary" title="Save" busy={busy} disabled={!(/^\d{1,7}(\.\d{1,2})?$/.test(typed.trim()) && /^\d{1,7}(\.\d{1,2})?$/.test(pw.trim()))} onPress={() => run(`mutation($b:ID!,$m:String!,$g:String!){ setBrokerCommissionPerLot(brokerId:$b, perMiniLot:$m, perMegaLot:$g){ id } }`, { b: u.id, m: typed.trim(), g: pw.trim() }, 'Commission updated')} />}
        {act === 'signout' && <Button block kind="sell" title="Sign out" busy={busy} onPress={() => run(`mutation($u:ID!,$s:ID){ revokeUserSessions(userId:$u, sessionId:$s) }`, { u: u.id, s: null }, 'Signed out everywhere')} />}
      </Row>
    </Sheet>
  );
}

/* ============================================================== security */
type SecTab = 'logins' | 'consents' | 'checks';
export function AdminSecurityScreen() {
  const { me } = useAuth();
  const [tab, setTab] = useState<SecTab>('logins');
  const [outcome, setOutcome] = useState<'' | 'FAILURE' | 'DENIED'>('');
  const logins = useQuery<{ loginAudit: LoginEvent[] }>(`query($o:String,$n:Int){ loginAudit(outcome:$o, limit:$n){ ${LOGIN_FIELDS} } }`, { o: outcome || undefined, n: 200 }, 30000, !me?.mfaEnabled || tab !== 'logins');
  const consents = useQuery<{ consentLog: ConsentRecord[] }>(`query($n:Int){ consentLog(limit:$n){ ${CONSENT_FIELDS} } }`, { n: 200 }, undefined, !me?.mfaEnabled || tab !== 'consents');
  if (!me?.mfaEnabled) return <AdminMfaGate title="Security" />;
  const tabs = <Tabs value={tab} onChange={setTab} items={[{ k: 'logins', label: 'Sign-ins' }, { k: 'consents', label: 'Consents' }, { k: 'checks', label: 'Checks' }]} />;
  if (tab === 'checks') return <Screen title="Security" right={<BellButton />}>{tabs}<Checks /></Screen>;
  if (tab === 'consents') {
    const list = consents.data?.consentLog ?? [];
    return (
      <Screen title="Security" scroll={false} right={<BellButton />}>
        <VList data={list} keyOf={(c) => c.id} header={<>{tabs}<T v="xs">Every time a trader accepted the trading rules, with time, IP and device.</T></>}
          empty={consents.loading && !consents.data ? <Skeleton /> : consents.error && !consents.data ? <ErrorState error={consents.error} retry={consents.refetch} /> : <Empty icon="shield" title="No consents yet" />}
          render={(c) => <ListRow left={<IconMark icon="shield" tone="brand" />} title={`${c.displayName ?? c.username ?? ''} accepted the rules`} sub={<View><T v="xs">{stamp(c.acceptedAt)}</T><T v="xs">IP {c.ip} · {deviceLabel(c.userAgent)}</T></View>} />} />
      </Screen>
    );
  }
  const list = logins.data?.loginAudit ?? [];
  return (
    <Screen title="Security" scroll={false} right={<BellButton />}>
      <VList data={list} keyOf={(e) => String(e.seq)}
        header={<>{tabs}<Chips value={outcome} onChange={setOutcome} items={[{ k: '', label: 'All' }, { k: 'FAILURE', label: 'Failed' }, { k: 'DENIED', label: 'Blocked' }]} /></>}
        empty={logins.loading && !logins.data ? <Skeleton /> : logins.error && !logins.data ? <ErrorState error={logins.error} retry={logins.refetch} /> : <Empty icon="lock" title="Nothing here" />}
        render={(e) => <LoginRow e={e} />} />
    </Screen>
  );
}

const LoginRow = memo(function LoginRow({ e }: { e: LoginEvent }) {
  const label = (LOGIN_LABEL as Record<string, string>)[e.action] ?? e.action;
  return (
    <ListRow onPress={e.userId ? () => router.push(`/admin-user/${e.userId}`) : undefined} left={<IconMark icon={e.outcome === 'SUCCESS' ? 'lock' : 'alert'} tone={e.outcome === 'SUCCESS' ? 'pos' : 'neg'} />}
      title={<Row gap={6}><T w="600" numberOfLines={1} style={{ flexShrink: 1 }}>{e.username ?? 'Unknown user'}</T>{e.outcome !== 'SUCCESS' && <Badge text={e.outcome === 'DENIED' ? 'Blocked' : 'Failed'} tone={e.outcome === 'DENIED' ? 'warn' : 'bad'} />}</Row>}
      sub={<View><T v="xs">{label} · {stamp(e.at)}{e.detail ? ` · ${e.detail}` : ''}</T><T v="xs">IP {e.ip ?? '—'} · {deviceLabel(e.userAgent)}</T></View>} />
  );
});

function Checks() {
  const runs = useQuery<{ reconciliationRuns: { id: string; ok: boolean; summaryJson: string; createdAt: string }[] }>(`{ reconciliationRuns { id ok summaryJson createdAt } }`);
  const [chain, setChain] = useState<{ ok: boolean; checked: number; brokenAtSeq?: string } | null>(null);
  const [busy, setBusy] = useState<'chain' | 'recon' | null>(null);
  return (
    <View style={{ gap: S[5] }}>
      <Section title="Audit trail">
        <T v="sm" c="text2">Every audit event is chained to the one before it with SHA-256. Checking re-computes the whole chain.</T>
        {chain && <Notice tone={chain.ok ? 'ok' : 'err'}>{chain.ok ? `Intact: ${chain.checked.toLocaleString('en-IN')} events checked.` : `Broken at event #${chain.brokenAtSeq}. Investigate on the web portal.`}</Notice>}
        <Button title="Check the audit chain" icon="shield" busy={busy === 'chain'} onPress={async () => {
          setBusy('chain');
          try { const d = await gql<{ verifyAuditChain: { ok: boolean; checked: number; brokenAtSeq?: string } }>(`{ verifyAuditChain { ok checked brokenAtSeq } }`); setChain(d.verifyAuditChain); } catch (e) { toast((e as Error).message, true); }
          setBusy(null);
        }} />
      </Section>
      <Section title="Reconciliation">
        <T v="sm" c="text2">Checks that every ledger balances and matches positions and orders.</T>
        <Button title="Run reconciliation now" icon="activity" busy={busy === 'recon'} onPress={async () => {
          setBusy('recon');
          try { const d = await gql<{ runReconciliation: { ok: boolean } }>(`mutation { runReconciliation { ok } }`); toast(d.runReconciliation.ok ? 'Reconciliation passed' : 'Reconciliation found problems', !d.runReconciliation.ok); void runs.refetch(); } catch (e) { toast((e as Error).message, true); }
          setBusy(null);
        }} />
        {runs.loading && !runs.data ? <Skeleton rows={2} /> : runs.error && !runs.data ? <ErrorState error={runs.error} retry={runs.refetch} /> : (runs.data?.reconciliationRuns ?? []).slice(0, 10).map((r) => (
          <ListRow key={r.id} left={<IconMark icon={r.ok ? 'check' : 'alert'} tone={r.ok ? 'pos' : 'neg'} />} title={r.ok ? 'Passed' : 'Problems found'} sub={when(r.createdAt)} right={<Badge text={r.ok ? 'OK' : 'Check'} tone={r.ok ? 'ok' : 'bad'} />} />
        ))}
      </Section>
      <T v="xs" style={{ textAlign: 'center' }}>Configuration changes and log archives are on the web portal.</T>
    </View>
  );
}

/* ============================================================== broker commissions */
export function CommissionsScreen() {
  const t = useTheme();
  const [m, setM] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const range = useMemo(() => ({ f: new Date(m.y, m.m, 1).toISOString(), t: new Date(m.y, m.m + 1, 1).toISOString() }), [m]);
  const q = useQuery<{ commissionReport: { perMiniLot: string; perMegaLot: string; total: string; lines: { userId: string; username: string; brokerage: string; miniLots: number; megaLots: number; commission: string }[] } }>(
    `query($f:DateTime!,$t:DateTime!){ commissionReport(from:$f,to:$t){ perMiniLot perMegaLot total lines{ userId username brokerage miniLots megaLots commission } } }`, range);
  const r = q.data?.commissionReport;
  const brokerage = r?.lines.reduce((a, l) => a + Number(l.brokerage), 0).toFixed(2);
  const now = new Date();
  const isCurrent = m.y === now.getFullYear() && m.m === now.getMonth();
  const label = new Date(m.y, m.m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const shift = (n: number) => setM((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  return (
    <Screen back title="Commissions">
      <T v="sm" c="text2">You earn a fixed amount for every lot your traders open or cut.</T>
      <Spread>
        <Pressable onPress={() => shift(-1)} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={8} style={{ padding: S[2] }}><Icon name="chevronLeft" size={20} color={t.text} /></Pressable>
        <T v="h3">{label}</T>
        <Pressable disabled={isCurrent} onPress={() => shift(1)} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={8} style={{ padding: S[2], opacity: isCurrent ? 0.3 : 1 }}><Icon name="chevronRight" size={20} color={t.text} /></Pressable>
      </Spread>
      {q.error && !r ? <ErrorState error={q.error} retry={q.refetch} /> : !r ? <Skeleton /> : (
        <>
          <Metrics items={[{ k: 'Your commission', v: `₹${inr(r.total)}`, tone: Number(r.total) > 0 ? 'pos' : 'flat' }, { k: 'Brokerage from traders', v: `₹${inr(brokerage)}` }, { k: 'Per lot', v: `₹${inr(r.perMiniLot)} mini · ₹${inr(r.perMegaLot)} mega` }, { k: 'Traders with trades', v: r.lines.length }]} />
          <Section title="By trader">
            {!r.lines.length ? <Empty icon="users" title="No trades this month" /> : r.lines.map((l) => (
              <ListRow key={l.userId} onPress={() => router.push(`/trader-detail/${l.userId}`)} label={`${l.username} commission`} title={l.username} sub={`${l.miniLots} mini · ${l.megaLots} mega lots · brokerage ₹${inr(l.brokerage)}`} right={<T v="num" c="pos">₹{inr(l.commission)}</T>} />
            ))}
          </Section>
        </>
      )}
      <View style={{ height: R.md }} />
    </Screen>
  );
}

/** Wipe-outs the account's owner did (fresh starts). Earlier data is hidden from them, not from you. */
function UserWipes({ userId }: { userId: string }) {
  const q = useQuery<{ accountWipes: { id: string; verifiedWith: string; balanceBefore: string; balanceAfter: string; snapshot: string; createdAt: string }[] }>(
    `query($u:ID!){ accountWipes(userId:$u){ id verifiedWith balanceBefore balanceAfter snapshot createdAt } }`, { u: userId });
  const rows = q.data?.accountWipes ?? [];
  if (!rows.length) return null;
  return (
    <Section title="Wipe-outs">
      <T v="xs">Everything before each wipe is hidden from the trader and their broker. You still see it.</T>
      {rows.map((w) => {
        const s = JSON.parse(w.snapshot) as { positions: { symbol: string }[]; watchlist: unknown[]; cancelledOrders: unknown[]; stoppedStrategies: unknown[] };
        return <ListRow key={w.id} left={<IconMark icon="alert" tone="warn" />} title={`₹${inr(w.balanceBefore)} → ₹${inr(w.balanceAfter)}`} sub={`${when(w.createdAt)} · via ${w.verifiedWith.toLowerCase()} · cleared ${s.positions.length} positions, ${s.watchlist.length} watchlist items, ${s.cancelledOrders.length} orders`} />;
      })}
    </Section>
  );
}

/* ============================================================ permanent deletes waiting for a second Super Admin */
interface Deletion { id: string; status: string; targetUserId: string; targetUsername: string; targetRole: string; reason: string; requestedById: string; expiresAt: string; createdAt: string }
export function PendingDeletions({ userId, onDeleted }: { userId?: string; onDeleted?: () => void }) {
  const { me } = useAuth();
  const t = useTheme();
  const sole = useSoleAdmin();
  const q = useQuery<{ userDeletions: Deletion[] }>(`query($u:ID){ userDeletions(userId:$u){ id status targetUserId targetUsername targetRole reason requestedById expiresAt createdAt } }`, { u: userId }, 30000);
  const [approve, setApprove] = useState<Deletion | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rows = (q.data?.userDeletions ?? []).filter((d) => d.status === 'PENDING' && new Date(d.expiresAt).getTime() > Date.now());
  if (!rows.length) return null;
  const act = async (query: string, v: Record<string, unknown>, ok: string, deleted = false) => {
    setBusy(true); setErr(null);
    try { await gql(query, v); toast(ok); setApprove(null); void q.refetch(); if (deleted) onDeleted?.(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <View style={{ borderWidth: 1, borderColor: t.neg, borderRadius: R.lg, padding: S[3], gap: S[2] }}>
      <Row gap={S[2]}><Icon name="alert" size={18} color={t.neg} /><T w="600">Waiting for a second Super Admin: delete</T></Row>
      {rows.map((d) => {
        const mine = d.requestedById === me?.id;
        return (
          <View key={d.id} style={{ gap: S[2] }}>
            <T w="600">{d.targetUsername} · {ROLE[d.targetRole] ?? d.targetRole}</T>
            <T v="xs">{d.reason} · asked {when(d.createdAt)}{mine ? ' by you' : ''} · expires {when(d.expiresAt)}</T>
            <Row gap={S[2]}>
              {(!mine || sole) && <View style={{ flex: 1 }}><Button block size="sm" kind="sell" title="Approve delete" onPress={() => { setTyped(''); setErr(null); setApprove(d); }} /></View>}
              <View style={{ flex: 1 }}><Button block size="sm" title={mine ? 'Cancel request' : 'Reject'} busy={busy && !approve} onPress={() => void act(`mutation($id:ID!){ rejectUserDeletion(id:$id){ id } }`, { id: d.id }, mine ? 'Request cancelled' : 'Request rejected')} /></View>
            </Row>
          </View>
        );
      })}
      {approve && (
        <Sheet visible title={`Delete ${approve.targetUsername} now?`} sub={`Reason given: ${approve.reason}`} onClose={() => setApprove(null)}>
          <Notice tone="err">This erases the account and all its data at once. It can’t be undone.</Notice>
          <Field label={`Type ${approve.targetUsername} to confirm`} autoCapitalize="none" autoCorrect={false} value={typed} onChangeText={setTyped} />
          {err && <Notice tone="err">{err}</Notice>}
          <Row>
            <Button block title="Cancel" onPress={() => setApprove(null)} />
            <Button block kind="sell" title="Delete permanently" busy={busy} disabled={typed.trim().toLowerCase() !== approve.targetUsername} onPress={() => void act(`mutation($id:ID!,$w:String!){ approveUserDeletion(id:$id, confirm:$w) }`, { id: approve.id, w: typed.trim() }, `${approve.targetUsername} deleted`, true)} />
          </Row>
        </Sheet>
      )}
    </View>
  );
}

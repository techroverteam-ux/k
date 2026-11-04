/** Payment screenshot: pick from the gallery, shrink to an uploadable JPEG, and show it (trader and admin). */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Image, Pressable, View } from 'react-native';
import { R, S, useTheme } from './theme';
import { ErrorState, Skeleton, T, useQuery } from './ui';

const MAX_BYTES = 500 * 1024; // the API accepts up to 550 kB
const bytesOf = (b64: string) => Math.floor((b64.length * 3) / 4);

/** Opens the photo picker; returns a data URL (JPEG, ≤ 500 kB, max 1600 px) or null if cancelled. */
export async function pickProof(): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Allow access to your photos to attach the payment screenshot.');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsMultipleSelection: false, exif: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  let side = 1600;
  for (let attempt = 0; attempt < 5; attempt++) {
    const long = Math.max(a.width || side, a.height || side);
    const ctx = ImageManipulator.manipulate(a.uri);
    if (long > side) ctx.resize(a.width >= a.height ? { width: side } : { height: side });
    const img = await ctx.renderAsync();
    for (const compress of [0.8, 0.65, 0.5]) {
      const out = await img.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
      if (out.base64 && bytesOf(out.base64) <= MAX_BYTES) return `data:image/jpeg;base64,${out.base64}`;
    }
    side = Math.round(side * 0.75);
  }
  throw new Error('Couldn’t make that image small enough. Crop the screenshot and try again.');
}

/** The stored screenshot for a fee payment, loaded on demand. */
export function ProofImage({ id, height = 320 }: { id: string; height?: number }) {
  const t = useTheme();
  const q = useQuery<{ feePaymentProof: string }>(`query($id:ID!){ feePaymentProof(id:$id) }`, { id });
  if (q.error && !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data) return <Skeleton />;
  return (
    <View style={{ borderRadius: R.md, overflow: 'hidden', borderWidth: 1, borderColor: t.line, backgroundColor: t.bg2 }}>
      <Image source={{ uri: q.data.feePaymentProof }} style={{ width: '100%', height }} resizeMode="contain" accessibilityLabel="Payment screenshot" />
    </View>
  );
}

/** Small preview of a picked screenshot with Change / Remove. */
export function ProofPicked({ uri, onChange, onRemove }: { uri: string; onChange: () => void; onRemove: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: S[3], alignItems: 'flex-start' }}>
      <Image source={{ uri }} style={{ width: 84, height: 112, borderRadius: R.md, borderWidth: 1, borderColor: t.line }} resizeMode="cover" accessibilityLabel="Attached screenshot" />
      <View style={{ gap: S[2] }}>
        <T v="sm" c="text2">Screenshot attached</T>
        <Pressable onPress={onChange} accessibilityRole="button" hitSlop={6}><T c="brand" w="600">Change</T></Pressable>
        <Pressable onPress={onRemove} accessibilityRole="button" hitSlop={6}><T c="text2">Remove</T></Pressable>
      </View>
    </View>
  );
}

export type DedicatedMode = "pallet" | "boxes";

export interface BoxGroup {
  store_code: string;
  lg_code: string;
  box_count: number;
}

export interface PlannedVolume {
  store_code: string;
  lg_code: string;
  soc_code: string;
  volume_no: number;
  volume_total: number;
  box_count: number | null;
}

function lgNumber(lg: string): number {
  const match = lg.match(/\d+/);
  return match ? Number(match[0]) : -1;
}

export function planLabelVolumes(
  groups: BoxGroup[],
  socByStore: Map<string, string>,
  fallbackSoc: string,
  dedicatedMode: DedicatedMode,
): PlannedVolume[] {
  if (dedicatedMode !== "pallet" && dedicatedMode !== "boxes") {
    throw new Error("Modo de etiquetas dedicadas inválido");
  }
  if (!groups.length) throw new Error("Palete sem caixas para etiquetar");
  const stores = new Set(groups.map((group) => group.store_code));
  if (stores.has("") || groups.some((group) =>
    !group.lg_code || !Number.isSafeInteger(group.box_count) || group.box_count < 1
  )) {
    throw new Error("Caixas da palete sem loja, LG ou quantidade válida");
  }
  if (stores.size > 1 && socByStore.size === 0) {
    throw new Error("Palete mista sem SOC por loja em pallet_store_containers");
  }

  const sorted = [...groups].sort((a, b) =>
    lgNumber(b.lg_code) - lgNumber(a.lg_code) ||
    a.store_code.localeCompare(b.store_code) ||
    a.lg_code.localeCompare(b.lg_code)
  );
  const socFor = (storeCode: string): string => {
    const soc = socByStore.size > 0 ? socByStore.get(storeCode) : fallbackSoc;
    if (!soc?.trim()) throw new Error(`Palete sem SOC para a loja ${storeCode}`);
    return soc.trim();
  };

  if (stores.size === 1 && dedicatedMode === "pallet") {
    const first = sorted[0];
    return [{
      store_code: first.store_code,
      lg_code: first.lg_code,
      soc_code: socFor(first.store_code),
      volume_no: 1,
      volume_total: 1,
      box_count: sorted.reduce((total, group) => total + group.box_count, 0),
    }];
  }

  const volumes: PlannedVolume[] = [];
  for (const group of sorted) {
    const soc = socFor(group.store_code);
    for (let i = 0; i < group.box_count; i++) {
      volumes.push({
        store_code: group.store_code,
        lg_code: group.lg_code,
        soc_code: soc,
        volume_no: 0,
        volume_total: 0,
        box_count: null,
      });
    }
  }
  const totalBySoc = new Map<string, number>();
  for (const volume of volumes) {
    const key = `${volume.store_code}\0${volume.soc_code}`;
    totalBySoc.set(key, (totalBySoc.get(key) || 0) + 1);
  }
  const nextBySoc = new Map<string, number>();
  for (const volume of volumes) {
    const key = `${volume.store_code}\0${volume.soc_code}`;
    volume.volume_no = (nextBySoc.get(key) || 0) + 1;
    volume.volume_total = totalBySoc.get(key)!;
    nextBySoc.set(key, volume.volume_no);
  }
  return volumes;
}
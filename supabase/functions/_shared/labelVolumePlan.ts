export type DedicatedMode = "pallet" | "boxes";

export interface BoxGroup {
  store_code: string;
  lg_code: string;
  box_count: number;
  /** SOC próprio de cada caixa (pallet_items.soc_code), pela ordem de colocação. */
  box_socs?: string[];
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
  const hasBoxSocs = groups.some((group) => (group.box_socs?.length ?? 0) > 0);
  if (!hasBoxSocs && stores.size > 1 && socByStore.size === 0) {
    throw new Error("Palete mista sem SOC por loja em pallet_store_containers");
  }

  const sorted = [...groups].sort((a, b) =>
    lgNumber(b.lg_code) - lgNumber(a.lg_code) ||
    a.store_code.localeCompare(b.store_code) ||
    a.lg_code.localeCompare(b.lg_code)
  );

  // Planos com SOC por caixa: sempre uma etiqueta por caixa, cada uma com o seu SOC.
  // "Volume i de n" conta as caixas da loja nesta palete.
  if (hasBoxSocs) {
    const perBox: PlannedVolume[] = [];
    for (const group of sorted) {
      const socs = (group.box_socs ?? []).map((soc) => String(soc || "").trim());
      if (socs.length !== group.box_count || socs.some((soc) => !soc)) {
        throw new Error(`Caixas da loja ${group.store_code} sem SOC próprio em todas as caixas`);
      }
      for (const soc of socs) {
        perBox.push({
          store_code: group.store_code,
          lg_code: group.lg_code,
          soc_code: soc,
          volume_no: 0,
          volume_total: 0,
          box_count: null,
        });
      }
    }
    const totalByStore = new Map<string, number>();
    for (const volume of perBox) {
      totalByStore.set(volume.store_code, (totalByStore.get(volume.store_code) || 0) + 1);
    }
    const nextByStore = new Map<string, number>();
    for (const volume of perBox) {
      volume.volume_no = (nextByStore.get(volume.store_code) || 0) + 1;
      volume.volume_total = totalByStore.get(volume.store_code)!;
      nextByStore.set(volume.store_code, volume.volume_no);
    }
    return perBox;
  }
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
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { Settings2 } from 'lucide-react';
import type { PalletizationRules } from '@/types/palletization';

interface PalletizationRulesFormProps {
  rules: PalletizationRules;
  onChange: (rules: PalletizationRules) => void;
}

export function PalletizationRulesForm({ rules, onChange }: PalletizationRulesFormProps) {
  return (
    <IndustrialCard className="mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Settings2 className="w-5 h-5" />
        </div>
        <div>
          <h3 className="font-semibold">Regras de Paletização</h3>
          <p className="text-sm text-muted-foreground">Configure as regras para otimização</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
          <div className="space-y-0.5">
            <Label htmlFor="prefer-full" className="text-base cursor-pointer">
              Preferir Paletes Completas
            </Label>
            <p className="text-sm text-muted-foreground">
              Minimizar paletes parcialmente cheias
            </p>
          </div>
          <Switch
            id="prefer-full"
            checked={rules.prefer_full_pallets}
            onCheckedChange={(checked) =>
              onChange({ ...rules, prefer_full_pallets: checked })
            }
          />
        </div>

        <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
          <div className="space-y-0.5">
            <Label htmlFor="allow-mixed" className="text-base cursor-pointer">
              Permitir Paletes Mistas
            </Label>
            <p className="text-sm text-muted-foreground">
              Misturar artigos diferentes na mesma palete
            </p>
          </div>
          <Switch
            id="allow-mixed"
            checked={rules.allow_mixed_pallets}
            onCheckedChange={(checked) =>
              onChange({ ...rules, allow_mixed_pallets: checked })
            }
          />
        </div>

        <div className="p-4 bg-muted/50 rounded-lg">
          <Label htmlFor="max-weight" className="text-base">
            Peso Máximo (kg)
          </Label>
          <p className="text-sm text-muted-foreground mb-2">
            Limite de peso por palete
          </p>
          <Input
            id="max-weight"
            type="number"
            placeholder="Sem limite"
            value={rules.max_pallet_weight_kg || ''}
            onChange={(e) =>
              onChange({
                ...rules,
                max_pallet_weight_kg: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            className="h-11"
          />
        </div>
      </div>
    </IndustrialCard>
  );
}

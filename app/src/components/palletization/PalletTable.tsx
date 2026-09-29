import { Box, AlertTriangle } from 'lucide-react';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PalletPlanResult } from '@/types/palletization';

interface Props {
  pallets: PalletPlanResult[];
  orderId?: string;
  onView3D: (index: number) => void;
}

export function PalletTable({ pallets, orderId, onView3D }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Nº</TableHead>
          <TableHead>Tamanho</TableHead>
          <TableHead>LG(s)</TableHead>
          <TableHead>Lojas</TableHead>
          <TableHead className="text-right">Caixas</TableHead>
          <TableHead className="text-right">Camadas</TableHead>
          <TableHead className="text-right">Altura</TableHead>
          <TableHead>Tipo</TableHead>
          <TableHead className="text-right">3D</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pallets.map((p, idx) => (
          <TableRow key={p.id}>
            <TableCell className="font-bold">{p.pallet_number}</TableCell>
            <TableCell className="font-mono">{p.pallet_size}cm</TableCell>
            <TableCell className="font-mono text-sm">
              {p.lg_codes.map((lg) => lg.replace(/^LG/i, '')).join(', ') || '—'}
            </TableCell>
            <TableCell className="font-mono text-sm">{p.store_codes.join(', ') || '—'}</TableCell>
            <TableCell className="text-right">{p.total_boxes}</TableCell>
            <TableCell className="text-right">{p.total_layers}</TableCell>
            <TableCell className="text-right">{(p.height_mm / 1000).toFixed(2)} m</TableCell>
            <TableCell>
              {p.single_label ? (
                <Badge className="bg-emerald-600 hover:bg-emerald-600">COMPLETA · 1 etiqueta</Badge>
              ) : p.is_mixed ? (
                <Badge variant="destructive">MISTA</Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-2">
                {p.warnings.length > 0 && (
                  <AlertTriangle className="w-4 h-4 text-warning" aria-label={p.warnings.join(' · ')} />
                )}
                <IndustrialButton size="sm" variant="outline" onClick={() => onView3D(idx)}>
                  Pré-visualizar
                </IndustrialButton>
                <IndustrialButton
                  size="sm"
                  onClick={() =>
                    orderId &&
                    window.open(`/paletizacao/${orderId}/palete/${p.pallet_number}/3d`, '_blank', 'noopener')
                  }
                  icon={<Box className="w-4 h-4" />}
                >
                  Ver 3D
                </IndustrialButton>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

import { useState } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { IndustrialButton } from '@/components/ui/IndustrialButton';

interface DeleteOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderNumber: string;
  onConfirm: () => Promise<void>;
}

export function DeleteOrderDialog({ open, onOpenChange, orderNumber, onConfirm }: DeleteOrderDialogProps) {
  const [checked, setChecked] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const canConfirm = checked && confirmText === 'ELIMINAR';

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setIsDeleting(true);
    try {
      await onConfirm();
    } finally {
      setIsDeleting(false);
      setChecked(false);
      setConfirmText('');
    }
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setChecked(false);
      setConfirmText('');
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-destructive" />
            </div>
            <div>
              <DialogTitle>Eliminar Encomenda</DialogTitle>
              <DialogDescription>Esta ação é irreversível</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">
              Vai eliminar permanentemente a encomenda:
            </p>
            <p className="text-lg font-bold text-foreground mt-1">{orderNumber}</p>
            <p className="text-xs text-muted-foreground mt-2">
              Todos os dados relacionados serão apagados: linhas, paletes, etiquetas e ficheiros.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Checkbox
              id="confirm-delete"
              checked={checked}
              onCheckedChange={(v) => setChecked(v === true)}
            />
            <label htmlFor="confirm-delete" className="text-sm font-medium cursor-pointer">
              Confirmo que quero eliminar esta encomenda
            </label>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1.5">
              Escreva <span className="font-bold text-destructive">ELIMINAR</span> para confirmar:
            </label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="ELIMINAR"
              className="font-mono"
            />
          </div>
        </div>

        <DialogFooter>
          <IndustrialButton variant="ghost" onClick={() => handleOpenChange(false)} disabled={isDeleting}>
            Cancelar
          </IndustrialButton>
          <IndustrialButton
            variant="destructive"
            onClick={handleConfirm}
            disabled={!canConfirm}
            isLoading={isDeleting}
            icon={<Trash2 className="w-4 h-4" />}
          >
            Eliminar Encomenda
          </IndustrialButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

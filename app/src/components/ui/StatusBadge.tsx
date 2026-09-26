import { cn } from '@/lib/utils';
import type { OrderStatus } from '@/types/database';
import { ORDER_STATUS_LABELS } from '@/types/database';
import { CheckCircle2, Clock, Package, Tag } from 'lucide-react';

interface StatusBadgeProps {
  status: OrderStatus;
  size?: 'sm' | 'md' | 'lg';
}

const statusConfig: Record<OrderStatus, { icon: typeof Clock; className: string }> = {
  importado: { icon: Clock, className: 'status-importado' },
  validado: { icon: CheckCircle2, className: 'status-validado' },
  paletizado: { icon: Package, className: 'status-paletizado' },
  etiquetas_geradas: { icon: Tag, className: 'status-etiquetas' },
};

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'status-badge',
        config.className,
        size === 'sm' && 'text-xs px-2 py-1',
        size === 'lg' && 'text-base px-4 py-2'
      )}
    >
      <Icon className={cn('mr-1.5', size === 'sm' ? 'w-3 h-3' : 'w-4 h-4')} />
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}

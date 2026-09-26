import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface IndustrialCardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  variant?: 'default' | 'interactive' | 'highlight';
}

export function IndustrialCard({ children, className, onClick, variant = 'default' }: IndustrialCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'bg-card rounded-xl border-2 border-border p-6 shadow-sm transition-all duration-200',
        variant === 'interactive' && 'cursor-pointer hover:border-primary/50 hover:shadow-industrial',
        variant === 'highlight' && 'border-accent/50 bg-accent/5',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {children}
    </div>
  );
}

interface IndustrialCardHeaderProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function IndustrialCardHeader({ title, subtitle, icon, action }: IndustrialCardHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            {icon}
          </div>
        )}
        <div>
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

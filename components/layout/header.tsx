'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { LogOut, History, Shield, LayoutGrid, Sparkles, User, Workflow, Images, CreditCard, MessageSquare, Video } from 'lucide-react';
import type { SafeUser } from '@/types';
import { cn } from '@/lib/utils';
import { useSiteConfig } from '@/components/providers/site-config-provider';
import { ThemeToggle } from '@/components/ui/theme-toggle';

interface HeaderProps {
  user: SafeUser;
}

// 移动端底部导航项
const mobileNavItems = [
  { href: '/image', icon: Sparkles, label: '图片' },
  { href: '/batch-image', icon: Images, label: '\u6279\u91cf' },
  { href: '/video', icon: Video, label: '视频' },
  { href: '/chat', icon: MessageSquare, label: '\u804a\u5929' },
  { href: '/workspace', icon: Workflow, label: '工作流' },
  { href: '/square', icon: LayoutGrid, label: '广场' },
  { href: '/history', icon: History, label: '历史' },
  { href: '/recharge', icon: CreditCard, label: '充兑' },
  { href: '/settings', icon: User, label: '我的' },
];

export function Header({ user }: HeaderProps) {
  const pathname = usePathname();
  const siteConfig = useSiteConfig();
  const isAdmin = user.role === 'admin' || user.role === 'moderator';
  const visibleMobileNavItems = mobileNavItems.filter(
    (item) => item.href !== '/square' || siteConfig.squareEnabled
  );

  return (
    <>
      {/* Top Header */}
      <header className="fixed top-0 left-0 right-0 h-14 bg-card/80 backdrop-blur-xl border-b border-border/50 z-50">
        <div className="h-full px-4 lg:px-6 flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-foreground tracking-tight">{siteConfig.siteName}</span>
          </Link>

          {/* Right Actions */}
          <div className="flex items-center gap-2">
            <ThemeToggle />

            {/* Admin Link */}
            {isAdmin && (
              <Link 
                href="/admin"
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  pathname.startsWith('/admin')
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                    : 'text-foreground/60 hover:bg-foreground/5'
                )}
              >
                <Shield className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">管理</span>
              </Link>
            )}
            
            {/* Logout - Desktop Only */}
            <button
              className="hidden lg:flex p-2 hover:bg-foreground/5 rounded-lg transition-colors"
              onClick={() => signOut({ callbackUrl: '/login' })}
              title="退出登录"
            >
              <LogOut className="w-4 h-4 text-foreground/60" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Tab Navigation - Premium Floating Dock */}
      <div className="lg:hidden fixed bottom-5 left-0 right-0 z-50 px-4 flex justify-center">
        <nav className="w-full max-w-sm bg-card/80 border border-border/80 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.55),0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl px-2 py-1.5 flex justify-around items-center">
          {visibleMobileNavItems.map((item) => {
            const isImageEntry = item.href === '/image';
            const isActive = isImageEntry
              ? pathname === '/image' || pathname === '/create'
              : pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'relative flex flex-col items-center justify-center py-1.5 px-3 rounded-xl transition-all duration-300 active:scale-95 flex-1 min-w-0',
                  isActive ? 'text-sky-400' : 'text-foreground/45 hover:text-foreground/75'
                )}
              >
                {isActive && (
                  <div className="absolute inset-0 bg-gradient-to-br from-sky-500/12 to-indigo-500/12 rounded-xl border border-sky-500/25 shadow-[0_2px_12px_rgba(14,165,233,0.15)] -z-10 animate-fadeIn" />
                )}
                <item.icon className="w-5 h-5 mb-0.5 transition-transform duration-300" strokeWidth={isActive ? 2.2 : 1.6} />
                <span className="text-[9px] font-bold tracking-wider">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

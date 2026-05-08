import {
  Home,
  Inbox,
  Filter,
  CheckSquare,
  Mail,
  MailCheck,
  Calendar as CalendarIcon,
  Briefcase,
  Target,
  Users,
  Handshake,
  Landmark,
  Wallet,
  Lightbulb,
  FileText,
  Share2,
  Newspaper,
  Send,
  ListOrdered,
  CheckCircle2,
  Terminal as TerminalIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  Icon: typeof Inbox;
}
export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Dashboard', Icon: Home },
      { to: '/sessions', label: 'Sessions', Icon: TerminalIcon },
      { to: '/mail/inbox', label: 'Inbox', Icon: Inbox },
    ],
  },
  {
    label: 'Daily Ops',
    items: [
      { to: '/mail/triage', label: 'Triage', Icon: Filter },
      { to: '/pkg/com.ikenga.tasks/', label: 'Tasks', Icon: CheckSquare },
      { to: '/mail/all', label: 'Emails', Icon: Mail },
      { to: '/mail/drafts', label: 'Reply Drafts', Icon: MailCheck },
      { to: '/calendar', label: 'Calendar', Icon: CalendarIcon },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { to: '/pkg/com.ikenga.product/strategy', label: 'Strategy', Icon: Target },
      { to: '/pkg/com.ikenga.gtm/sales', label: 'Sales', Icon: Users },
      { to: '/pkg/com.ikenga.gtm/partnerships', label: 'Partnerships', Icon: Handshake },
      { to: '/pkg/com.ikenga.gtm/fundraising', label: 'Fundraising', Icon: Landmark },
      { to: '/pkg/com.ikenga.finance/finance', label: 'Finance', Icon: Wallet },
    ],
  },
  {
    label: 'Outbox',
    items: [
      { to: '/outbox/email', label: 'Email', Icon: Send },
      { to: '/outbox/newsletter', label: 'Newsletter', Icon: Newspaper },
      { to: '/outbox/social', label: 'Social', Icon: Share2 },
      { to: '/outbox/sequences', label: 'Sequences', Icon: ListOrdered },
      { to: '/outbox/sent', label: 'Sent', Icon: CheckCircle2 },
    ],
  },
  {
    label: 'Product',
    items: [
      { to: '/executive', label: 'Executive', Icon: Briefcase },
      { to: '/pkg/com.ikenga.product/features', label: 'Features', Icon: Lightbulb },
      { to: '/content', label: 'Content', Icon: FileText },
    ],
  },
];

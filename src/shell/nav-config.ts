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
      { to: '/pkg/com.ikenga.email/mail/inbox', label: 'Inbox', Icon: Inbox },
    ],
  },
  {
    label: 'Daily Ops',
    items: [
      { to: '/pkg/com.ikenga.email/mail/triage', label: 'Triage', Icon: Filter },
      { to: '/pkg/com.ikenga.tasks/', label: 'Tasks', Icon: CheckSquare },
      { to: '/pkg/com.ikenga.email/mail/all', label: 'Emails', Icon: Mail },
      { to: '/pkg/com.ikenga.email/mail/drafts', label: 'Reply Drafts', Icon: MailCheck },
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
      { to: '/pkg/com.ikenga.email/outbox/email', label: 'Email', Icon: Send },
      { to: '/pkg/com.ikenga.email/outbox/newsletter', label: 'Newsletter', Icon: Newspaper },
      { to: '/pkg/com.ikenga.email/outbox/social', label: 'Social', Icon: Share2 },
      { to: '/pkg/com.ikenga.email/outbox/sequences', label: 'Sequences', Icon: ListOrdered },
      { to: '/pkg/com.ikenga.email/outbox/sent', label: 'Sent', Icon: CheckCircle2 },
    ],
  },
  {
    label: 'Product',
    items: [
      { to: '/pkg/com.ikenga.exec/executive', label: 'Executive', Icon: Briefcase },
      { to: '/pkg/com.ikenga.product/features', label: 'Features', Icon: Lightbulb },
      { to: '/pkg/com.ikenga.email/content', label: 'Content', Icon: FileText },
    ],
  },
];

import { redirect } from 'next/navigation'
export default function AnnualClosePage() { redirect(`/annual-close/${new Date().getFullYear()}`) }

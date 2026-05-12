'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	debounceMs?: number;
}

export function SearchInput({
	value,
	onChange,
	placeholder = 'Search...',
	className = '',
	debounceMs = 300,
}: SearchInputProps) {
	const [localValue, setLocalValue] = useState(value);

	// Sync local value when external value changes
	useEffect(() => {
		setLocalValue(value);
	}, [value]);

	// Debounced onChange
	useEffect(() => {
		const timer = setTimeout(() => {
			if (localValue !== value) {
				onChange(localValue);
			}
		}, debounceMs);

		return () => clearTimeout(timer);
	}, [localValue, value, onChange, debounceMs]);

	return (
		<div className={`relative ${className}`}>
			<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
			<input
				type="text"
				value={localValue}
				onChange={(e) => setLocalValue(e.target.value)}
				placeholder={placeholder}
				className="w-full pl-10 pr-10 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
			/>
			{localValue && (
				<button
					onClick={() => {
						setLocalValue('');
						onChange('');
					}}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
				>
					<X className="h-4 w-4" />
				</button>
			)}
		</div>
	);
}

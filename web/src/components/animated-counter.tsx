import { useEffect, useRef } from "react";
import { useMotionValue, useSpring, useTransform, motion } from "motion/react";
import { butlerSpring } from "@/lib/motion";

interface AnimatedCounterProps {
	value: number;
	className?: string;
}

export function AnimatedCounter({ value, className }: AnimatedCounterProps) {
	const motionValue = useMotionValue(0);
	const spring = useSpring(motionValue, butlerSpring);
	const display = useTransform(spring, (v) => Math.round(v));
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		motionValue.set(value);
	}, [value, motionValue]);

	useEffect(() => {
		const unsubscribe = display.on("change", (v) => {
			if (ref.current) {
				ref.current.textContent = String(v);
			}
		});
		return unsubscribe;
	}, [display]);

	return (
		<motion.span ref={ref} className={className}>
			{value}
		</motion.span>
	);
}

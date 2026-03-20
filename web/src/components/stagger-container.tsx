import { type ReactNode, Children } from "react";
import { motion, AnimatePresence } from "motion/react";
import { butlerSpring, butlerStagger, fadeSlideUp } from "@/lib/motion";

interface StaggerContainerProps {
	children: ReactNode;
	className?: string;
}

const containerVariants = {
	hidden: {},
	visible: {
		transition: {
			...butlerStagger,
		},
	},
};

export function StaggerContainer({ children, className }: StaggerContainerProps) {
	return (
		<motion.div
			className={className}
			variants={containerVariants}
			initial="hidden"
			animate="visible"
		>
			<AnimatePresence>
				{Children.map(children, (child, i) =>
					child ? (
						<motion.div
							key={i}
							variants={fadeSlideUp}
							transition={{ ...butlerSpring }}
						>
							{child}
						</motion.div>
					) : null,
				)}
			</AnimatePresence>
		</motion.div>
	);
}

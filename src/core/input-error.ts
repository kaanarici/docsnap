export class InputError extends Error {
	constructor(
		message: string,
		readonly next = "Correct the input and retry. Run docsnap --help if the expected argument is unclear.",
	) {
		super(message);
	}
}

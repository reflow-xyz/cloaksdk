import { Connection, PublicKey } from "@solana/web3.js";
import { log, warn, error as error } from "./logger";

export async function useExistingALT(
	connection: Connection,
	altAddress: PublicKey,
): Promise<{ value: any } | null> {
	try {
		log(`Using existing ALT: ${altAddress.toString()}`);
		const altAccount = await connection.getAddressLookupTable(
			altAddress,
		);

		if (altAccount.value) {
			log(
				`ALT found with ${altAccount.value.state.addresses.length} addresses`,
			);
		} else {
			log("ALT not found");
		}

		return altAccount;
	} catch (err) {
		error("Error getting existing ALT:", err);
		return null;
	}
}

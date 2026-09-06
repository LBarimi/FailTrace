using System;
using UnityEngine;

namespace FailTraceExample
{
    [Serializable]
    public class Inventory
    {
        public int[] items = Array.Empty<int>();
    }

    public static class InventoryStorage
    {
        // Deliberate example defect: saving drops the inventory contents.
        // Candidate fix: return JsonUtility.ToJson(inventory);
        public static string Save(Inventory inventory)
        {
            return JsonUtility.ToJson(new Inventory());
        }

        public static Inventory Load(string json)
        {
            return JsonUtility.FromJson<Inventory>(json);
        }
    }
}
